/**
 * `eutaxy draft`: a scenario skeleton from a wrangler config and the Worker
 * module it names. The config's bindings become setup steps, the Worker's
 * handlers the drive, the hosts its code fetches the externals; the
 * invariants and the drive's events are left as holes marked TODO, since
 * only the author knows what must hold and which events matter. Nothing is
 * imported or run: the config is read as JSON or JSONC and the module's
 * source (with the modules it imports relatively) is scanned as text.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { readWranglerConfig } from "./callees.ts";

/** The drive a draft chooses, with what names its target; the events themselves are left to fill in. */
export type DraftDrive =
  | { readonly kind: "queue"; readonly queue: string }
  | { readonly kind: "cron"; readonly cron: string }
  | { readonly kind: "websocket"; readonly agent: string }
  | { readonly kind: "http" };

/** A setup step a draft writes. Paths are relative to the scenario's directory. */
export type DraftStep =
  | { readonly kind: "d1"; readonly binding: string; readonly schemaFile: string }
  | { readonly kind: "durable_object"; readonly binding: string; readonly sqlite: boolean }
  | { readonly kind: "r2"; readonly binding: string }
  | {
      readonly kind: "workflow";
      readonly binding: string;
      readonly className: string;
      /** Its name in the config, which `event.workflowName` reads. */
      readonly name?: string;
    }
  | {
      readonly kind: "callee";
      readonly binding: string;
      readonly entry: string;
      readonly config: string;
    }
  | { readonly kind: "service"; readonly binding: string };

export interface Draft {
  readonly name: string;
  readonly worker: { readonly entry: string; readonly config: string };
  readonly drive: DraftDrive;
  readonly setup: readonly DraftStep[];
  readonly externals: readonly { readonly name: string; readonly host: string }[];
  /** What the draft could not decide or does not model, written into the file as comments. */
  readonly notes: readonly string[];
}

const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x) : [];
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A path relative to `from`, with forward slashes and a leading `./`. */
function ref(from: string, to: string): string {
  const p = relative(from, to).split("\\").join("/");
  return p.startsWith(".") ? p : `./${p}`;
}

/** Read a wrangler config as JSON or JSONC; TOML is not read. */
function readConfig(path: string): Record<string, unknown> {
  if (extname(path) !== ".json" && extname(path) !== ".jsonc")
    throw new Error(
      `${basename(path)}: eutaxy draft reads a wrangler config as JSON or JSONC; a TOML config is not read`,
    );
  return readWranglerConfig(path);
}

/** Binding kinds the simulation does not proxy: a run that touches one is UNSUPPORTED. */
const unmodelled: Readonly<Record<string, string>> = {
  kv_namespaces: "KV namespace",
  ai: "Workers AI",
  vectorize: "Vectorize index",
  hyperdrive: "Hyperdrive config",
  analytics_engine_datasets: "Analytics Engine dataset",
  browser: "Browser Rendering",
  send_email: "email sender",
  dispatch_namespaces: "dispatch namespace",
  mtls_certificates: "mTLS certificate",
  secrets_store_secrets: "Secrets Store secret",
  images: "Images",
  version_metadata: "version metadata",
  pipelines: "pipeline",
};

/** The SQLite-backed classes of a config's migrations (the ones created so, as wrangler applies them). */
function sqliteClasses(config: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const m of list(config["migrations"]))
    for (const c of Array.isArray(m["new_sqlite_classes"]) ? m["new_sqlite_classes"] : [])
      if (typeof c === "string") out.add(c);
  return out;
}

/**
 * The schema file of a D1 binding, beside its config: `schema.sql`, else `<database_name>.sql`, else the
 * only `.sql` file there; `found` false when none is, and the step names `schema.sql` to create.
 */
function schemaOf(configDir: string, database: string): { file: string; found: boolean } {
  for (const name of ["schema.sql", database ? `${database}.sql` : ""])
    if (name && existsSync(join(configDir, name)))
      return { file: join(configDir, name), found: true };
  const sql = readdirSync(configDir).filter((f) => f.endsWith(".sql"));
  if (sql.length === 1) return { file: join(configDir, sql[0] as string), found: true };
  return { file: join(configDir, "schema.sql"), found: false };
}

/**
 * A migrations directory's files in the order wrangler applies them (by name): its `.sql` files, and a
 * subdirectory's `migration.sql` (one folder per migration, as drizzle-kit writes them).
 */
function migrationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => {
      if (e.isFile() && e.name.endsWith(".sql")) return [join(dir, e.name)];
      const nested = join(dir, e.name, "migration.sql");
      return e.isDirectory() && existsSync(nested) ? [nested] : [];
    });
}

/** Wrangler configs under `root` (not in node_modules or dot directories), by their `name`. */
function configsByName(root: string, depth = 3): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, left: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0 && e.name !== "node_modules" && !e.name.startsWith(".")) walk(path, left - 1);
      } else if (e.name === "wrangler.jsonc" || e.name === "wrangler.json") {
        try {
          const name = text(readConfig(path)["name"]);
          if (name && !out.has(name)) out.set(name, path);
        } catch {
          // An unreadable config names nothing.
        }
      }
    }
  };
  walk(root, depth);
  return out;
}

/** The source of a module and of the modules it imports by relative path, transitively. */
function sources(entry: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    out.push(src);
    // `from` clauses (imports and re-exports), side-effect imports and dynamic imports of a literal path.
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = resolve(dirname(file), m[1] as string);
      const candidates = [spec, spec.replace(/\.js$/, ".ts"), `${spec}.ts`, join(spec, "index.ts")];
      const found = candidates.find((c) => existsSync(c) && extname(c) !== "");
      if (found) visit(found);
    }
  };
  visit(entry);
  return out;
}

/**
 * The hosts a module's code fetches by a literal URL, in order of first appearance, as `URL.host` has
 * them (which the fetch interceptor matches): lowercase, a non-default port kept.
 */
export function fetchedHosts(srcs: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const src of srcs)
    for (const m of src.matchAll(/\bfetch\(\s*["'`](https?):\/\/([a-z0-9.-]+)(?::(\d+))?/gi)) {
      const port = m[3];
      const defaultPort = (m[1] as string).toLowerCase() === "https" ? "443" : "80";
      const host = `${(m[2] as string).toLowerCase()}${port && port !== defaultPort ? `:${port}` : ""}`;
      if (!hosts.includes(host)) hosts.push(host);
    }
  return hosts;
}

/** An external's name from its host: the first label, made an identifier-like word, unique. */
function externalName(host: string, taken: Set<string>): string {
  const base = (host.split(".")[0] ?? host).replace(/[^a-z0-9-]/gi, "-") || "external";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/**
 * The SDK's route segment for an Agent's binding, as `routeAgentRequest` matches it: the Agents SDK's
 * `camelCaseToKebabCase` (an all-caps name lowercased, else a dash before every capital).
 */
export function agentSegment(binding: string): string {
  if (binding === binding.toUpperCase() && binding !== binding.toLowerCase())
    return binding.toLowerCase().replaceAll("_", "-");
  const kebab = binding.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return (kebab.startsWith("-") ? kebab.slice(1) : kebab).replaceAll("_", "-").replace(/-$/, "");
}

export interface DraftInput {
  /** The wrangler config, absolute. */
  readonly config: string;
  /** The Worker module, absolute; default: the config's `main`. */
  readonly entry?: string;
  /** Where the scenario will live, absolute; default: the config's directory. */
  readonly scenarioDir?: string;
}

export function draftScenario(input: DraftInput): Draft {
  const config = readConfig(input.config);
  const configDir = dirname(input.config);
  const scenarioDir = input.scenarioDir ?? configDir;
  const name = text(config["name"]) || basename(configDir);
  const main = text(config["main"]);
  if (input.entry === undefined && !main)
    throw new Error(`${basename(input.config)} names no main module; pass the Worker's module`);
  const entry = input.entry ?? resolve(configDir, main);
  if (!existsSync(entry)) throw new Error(`the Worker module ${entry} does not exist`);
  const notes: string[] = [];
  const setup: DraftStep[] = [];
  // The caller's own code decides the drive; with the callees' code it gives the externals.
  const callerSrcs = sources(entry);
  const srcs = [...callerSrcs];
  // The Workers behind the service bindings whose configs are found under the scenario's directory run
  // for real (callee()); their names decide which of the caller's bindings to their classes are shared.
  const others = list(config["services"]).length > 0 ? configsByName(scenarioDir) : new Map();
  const callees = new Map<string, string>();
  for (const s of list(config["services"])) {
    const service = text(s["service"]);
    const found = service && service !== name ? others.get(service) : undefined;
    if (found !== undefined) callees.set(service, found);
  }
  // The caller's databases and buckets: a callee binding the same one reads it under the caller's name.
  const d1Id = (db: Record<string, unknown>): string =>
    text(db["database_id"]) || text(db["database_name"]) || text(db["binding"]);
  const callerDatabases = new Map(
    list(config["d1_databases"]).map((db) => [d1Id(db), text(db["binding"])]),
  );
  const callerBuckets = new Map(
    list(config["r2_buckets"]).map((b) => [
      text(b["bucket_name"]) || text(b["binding"]),
      text(b["binding"]),
    ]),
  );
  /** Classes of a callee's script the caller binds itself: one namespace, set up under the caller's name. */
  const sharedClasses = new Set(
    list(record(config["durable_objects"])["bindings"])
      .filter((b) => callees.has(text(b["script_name"])))
      .map((b) => `${text(b["script_name"])}:${text(b["class_name"])}`),
  );

  /** The setup steps of one Worker's own resources: the caller's (prefix ""), or a callee's (`<name>/`). */
  const resourceSteps = (
    cfg: Record<string, unknown>,
    dir: string,
    worker: string,
    prefix: string,
  ): void => {
    const sqlite = sqliteClasses(cfg);
    for (const db of list(cfg["d1_databases"])) {
      const binding = text(db["binding"]);
      if (!binding) continue;
      const shared = prefix ? callerDatabases.get(d1Id(db)) : undefined;
      if (shared !== undefined) {
        notes.push(
          `D1 ${prefix}${binding} is the caller's database ${shared}: set it up and read it as ${shared}`,
        );
        continue;
      }
      const schema = schemaOf(dir, text(db["database_name"]));
      const migrations = schema.found
        ? []
        : migrationFiles(join(dir, text(db["migrations_dir"]) || "migrations"));
      if (migrations.length > 0) {
        // No schema file, but migrations: one step per migration, applied in order as wrangler does.
        for (const file of migrations)
          setup.push({
            kind: "d1",
            binding: `${prefix}${binding}`,
            schemaFile: ref(scenarioDir, file),
          });
        continue;
      }
      if (!schema.found)
        notes.push(
          `D1 ${prefix}${binding}: no schema file found; write the tables it needs into ${ref(scenarioDir, schema.file)}`,
        );
      setup.push({
        kind: "d1",
        binding: `${prefix}${binding}`,
        schemaFile: ref(scenarioDir, schema.file),
      });
    }
    for (const b of list(record(cfg["durable_objects"])["bindings"])) {
      const binding = text(b["name"]);
      const className = text(b["class_name"]);
      const script = text(b["script_name"]);
      if (!binding) continue;
      if (script && script !== worker) {
        // Another Worker's class: one shared namespace when that Worker runs here as a callee.
        if (!prefix && callees.has(script))
          setup.push({
            kind: "durable_object",
            binding,
            sqlite: sqliteClasses(readConfig(callees.get(script) as string)).has(className),
          });
        else
          notes.push(
            `Durable Object ${prefix}${binding} is ${script}'s class ${className}: name ${script} with callee() to run it`,
          );
        continue;
      }
      if (prefix && sharedClasses.has(`${worker}:${className}`)) {
        notes.push(
          `Durable Object ${prefix}${binding} is the namespace the caller binds to ${worker}'s class ${className}: set it up and read it under the caller's name`,
        );
        continue;
      }
      setup.push({
        kind: "durable_object",
        binding: `${prefix}${binding}`,
        sqlite: sqlite.has(className),
      });
    }
    for (const b of list(cfg["r2_buckets"])) {
      const binding = text(b["binding"]);
      if (!binding) continue;
      const shared = prefix ? callerBuckets.get(text(b["bucket_name"]) || binding) : undefined;
      if (shared !== undefined) {
        notes.push(
          `R2 ${prefix}${binding} is the caller's bucket ${shared}: set it up and read it as ${shared}`,
        );
        continue;
      }
      setup.push({ kind: "r2", binding: `${prefix}${binding}` });
    }
    for (const w of list(cfg["workflows"])) {
      const binding = text(w["binding"]);
      const className = text(w["class_name"]);
      const script = text(w["script_name"]);
      if (!binding || !className) continue;
      if (script && script !== worker) {
        notes.push(
          `Workflow ${prefix}${binding} runs in ${script}: name ${script} with callee() to run it`,
        );
        continue;
      }
      const workflowName = text(w["name"]);
      setup.push({
        kind: "workflow",
        binding: `${prefix}${binding}`,
        className,
        ...(workflowName ? { name: workflowName } : {}),
      });
    }
    for (const [key, what] of Object.entries(unmodelled)) {
      const v = cfg[key];
      const bindings = Array.isArray(v)
        ? list(v).map((b) => text(b["binding"]) || text(b["name"]))
        : v !== undefined
          ? [text(record(v)["binding"]) || key]
          : [];
      for (const b of bindings)
        notes.push(`not modelled: ${what} ${prefix}${b}; a run that touches it is UNSUPPORTED`);
    }
    for (const q of list(record(cfg["queues"])["producers"]))
      notes.push(
        `not modelled: Queue producer ${prefix}${text(q["binding"])}; a run that sends to it is UNSUPPORTED`,
      );
  };

  resourceSteps(config, configDir, name, "");
  for (const s of list(config["services"])) {
    const binding = text(s["binding"]);
    const service = text(s["service"]);
    if (!binding) continue;
    const calleeConfig = callees.get(service);
    if (calleeConfig === undefined) {
      setup.push({ kind: "service", binding });
      notes.push(
        `service binding ${binding}: no wrangler config named ${service || "(none)"} under the scenario's directory, so its answers are scripted; script them with service(), or run that Worker with callee()`,
      );
      continue;
    }
    const callee = readConfig(calleeConfig);
    const calleeDir = dirname(calleeConfig);
    const calleeMain = resolve(calleeDir, text(callee["main"]));
    setup.push({
      kind: "callee",
      binding,
      entry: ref(scenarioDir, calleeMain),
      config: ref(scenarioDir, calleeConfig),
    });
    resourceSteps(callee, calleeDir, service, `${service}/`);
    srcs.push(...sources(calleeMain));
  }

  // eutaxy check finds the Worker's module and its own schema files beneath the scenario's directory.
  const outside = [
    entry,
    ...setup.flatMap((s) =>
      s.kind === "d1" && !s.binding.includes("/") ? [resolve(scenarioDir, s.schemaFile)] : [],
    ),
  ].filter((f) => relative(scenarioDir, f).startsWith(".."));
  if (outside.length > 0)
    throw new Error(
      `eutaxy check finds the Worker's module and its schema files beneath the scenario's directory, and ${outside.map((f) => relative(scenarioDir, f)).join(", ")} is not; write the scenario beside the wrangler config or in a directory above the Worker`,
    );

  // The drive: a queue consumer, else a Cron Trigger, else an Agent's WebSocket route, else fetch().
  const consumers = list(record(config["queues"])["consumers"]);
  const crons = Array.isArray(record(config["triggers"])["crons"])
    ? (record(config["triggers"])["crons"] as unknown[]).filter((c) => typeof c === "string")
    : [];
  const routesAgents = callerSrcs.some((s) => /\brouteAgentRequest\s*\(/.test(s));
  const firstObject = setup.find((s) => s.kind === "durable_object" && !s.binding.includes("/"));
  let drive: DraftDrive;
  if (consumers.length > 0) {
    drive = { kind: "queue", queue: text(consumers[0]?.["queue"]) };
    if (consumers.length > 1)
      notes.push(
        `the Worker consumes ${consumers.length} queues; one drive per scenario, so a scenario per queue`,
      );
  } else if (crons.length > 0) drive = { kind: "cron", cron: crons[0] as string };
  else if (routesAgents && firstObject)
    drive = { kind: "websocket", agent: agentSegment(firstObject.binding) };
  else drive = { kind: "http" };
  if (drive.kind !== "cron" && crons.length > 0)
    notes.push(`the Worker also has Cron Triggers (${crons.join(", ")}); a scenario per drive`);

  const taken = new Set<string>();
  const externals = fetchedHosts(srcs).map((host) => ({ name: externalName(host, taken), host }));
  return {
    name,
    worker: { entry: ref(scenarioDir, entry), config: ref(scenarioDir, input.config) },
    drive,
    setup,
    externals,
    notes,
  };
}

const q = (s: string): string => JSON.stringify(s);

function stepSource(s: DraftStep): string {
  switch (s.kind) {
    case "d1":
      return `d1Schema(${q(s.binding)}, ${q(s.schemaFile)}),`;
    case "durable_object":
      return s.sqlite
        ? `// SQLite-backed: seed tables with { sql: { <object name>: { schema, rows } } }.\n    durableObject(${q(s.binding)}, {}),`
        : `durableObject(${q(s.binding)}, {}),`;
    case "r2":
      return `r2Bucket(${q(s.binding)}),`;
    case "workflow":
      return s.name === undefined
        ? `workflow(${q(s.binding)}, ${q(s.className)}),`
        : `workflow(${q(s.binding)}, ${q(s.className)}, { name: ${q(s.name)} }),`;
    case "callee":
      return `callee(${q(s.binding)}, { entry: ${q(s.entry)}, config: ${q(s.config)} }),`;
    case "service":
      return `// TODO: the answers of the Worker behind ${s.binding}, e.g. { methods: { <method>: { value: … } } }.\n    service(${q(s.binding)}),`;
  }
}

function driveSource(d: DraftDrive): { helper: string; source: string } {
  switch (d.kind) {
    case "queue":
      return {
        helper: "queue",
        source: `// TODO: the messages to deliver.\n  drive: queue(${q(d.queue)}, [{ body: {} }]),`,
      };
    case "cron":
      return {
        helper: "cron",
        source: `// TODO: how many ticks, and how many times a failed tick is re-run.\n  drive: cron(${q(d.cron)}, { ticks: 2 }),`,
      };
    case "websocket":
      return {
        helper: "websocket",
        source: `// TODO: the connections, the Agent instance they reach and the messages each sends.\n  drive: websocket([\n    { id: "a", path: ${q(`/agents/${d.agent}/<name>`)}, messages: [{ data: {} }] },\n  ]),`,
      };
    case "http":
      return {
        helper: "http",
        source: `// TODO: the requests, and how the caller resends one that got no 2xx.\n  drive: http([{ path: "/", body: {} }], { retries: 3 }),`,
      };
  }
}

/** Example invariants for the draft's bindings, as comments: the hole the author fills. */
function invariantHints(d: Draft): string[] {
  const hints: string[] = [];
  const d1 = d.setup.find((s) => s.kind === "d1");
  if (d1) hints.push(`unique("one-row-per-key", d1Rows(${q(d1.binding)}, "<table>"), "<column>"),`);
  const sqliteObject = d.setup.find((s) => s.kind === "durable_object" && s.sqlite);
  if (sqliteObject)
    hints.push(
      `everyRow("<rule>", durableObjectTable(${q(sqliteObject.binding)}, "<object name>", "<table>"), [{ column: "<column>", op: "gte", value: 0 }]),`,
    );
  const external = d.externals[0];
  if (external)
    hints.push(
      `atMostOncePerKey("<call>-once", fetchCall(${q(external.name)}, "POST"), "args.body.<id>"),`,
    );
  if (hints.length === 0)
    hints.push(
      `atMostOncePerKey("<effect>-once", httpResponse("/", { ok: true }), "args.requestId"),`,
    );
  return hints;
}

/** The scenario's source. With no invariant it does not check until the holes are filled. */
export function renderDraft(d: Draft): string {
  const drive = driveSource(d.drive);
  const helpers = new Set<string>(["defineScenario", drive.helper]);
  const stepHelper: Record<DraftStep["kind"], string> = {
    d1: "d1Schema",
    durable_object: "durableObject",
    r2: "r2Bucket",
    workflow: "workflow",
    callee: "callee",
    service: "service",
  };
  for (const s of d.setup) helpers.add(stepHelper[s.kind]);
  if (d.externals.length > 0) helpers.add("external");
  const imports = [...helpers].sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  lines.push(`import { ${imports.join(", ")} } from "eutaxy/cloudflare";`, "");
  lines.push(
    `// Drafted by eutaxy draft from ${d.worker.config}. Fill in each TODO, then run`,
    `// eutaxy check on this file; it does not check until it has an invariant.`,
  );
  for (const n of d.notes) lines.push(`// Note: ${n}.`);
  lines.push(`export default defineScenario({`);
  lines.push(`  name: ${q(d.name)},`);
  lines.push(`  worker: { entry: ${q(d.worker.entry)}, config: ${q(d.worker.config)} },`);
  if (d.setup.length > 0) {
    lines.push(`  setup: [`);
    for (const s of d.setup) lines.push(`    ${stepSource(s)}`);
    lines.push(`  ],`);
  }
  lines.push(`  ${drive.source}`);
  if (d.externals.length > 0) {
    lines.push(
      `  // Each host the Worker fetches answers 200 with an empty body until you script its responses.`,
    );
    lines.push(`  externals: [`);
    for (const e of d.externals) lines.push(`    external(${q(e.name)}, ${q(e.host)}),`);
    lines.push(`  ],`);
  }
  lines.push(`  invariants: [`);
  lines.push(
    `    // TODO: what must hold after every run, for example (import what you use from eutaxy/cloudflare):`,
  );
  for (const h of invariantHints(d)) lines.push(`    // ${h}`);
  lines.push(`  ],`);
  lines.push(
    `  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },`,
  );
  lines.push(`});`, "");
  return lines.join("\n");
}

export interface DraftOptions {
  readonly cwd: string;
  /** The wrangler config; default: wrangler.jsonc or wrangler.json in the working directory. */
  readonly config?: string;
  /** The Worker module; default: the config's `main`. */
  readonly worker?: string;
  /** Where to write the scenario; default: print it. An existing file is not overwritten. */
  readonly out?: string;
  readonly json: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Exit 0 with the draft printed or written, 3 on an error. */
export function runDraft(o: DraftOptions): number {
  const config =
    o.config !== undefined
      ? resolve(o.cwd, o.config)
      : ["wrangler.jsonc", "wrangler.json"].map((f) => join(o.cwd, f)).find((p) => existsSync(p));
  if (config === undefined || !existsSync(config)) {
    o.stderr(
      config === undefined
        ? "no wrangler.jsonc or wrangler.json in the working directory; name the config\n"
        : `wrangler config not found: ${config}\n`,
    );
    return 3;
  }
  const out = o.out === undefined ? undefined : resolve(o.cwd, o.out);
  if (out !== undefined && existsSync(out)) {
    o.stderr(`${out} exists; eutaxy draft does not overwrite a file\n`);
    return 3;
  }
  if (out !== undefined && !existsSync(dirname(out))) {
    o.stderr(`the directory of ${out} does not exist\n`);
    return 3;
  }
  let draft: Draft;
  try {
    draft = draftScenario({
      config,
      ...(o.worker === undefined ? {} : { entry: resolve(o.cwd, o.worker) }),
      ...(out === undefined ? {} : { scenarioDir: dirname(out) }),
    });
  } catch (err) {
    o.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
  const source = renderDraft(draft);
  if (out !== undefined) writeFileSync(out, source);
  if (o.json)
    o.stdout(
      `${JSON.stringify({ schemaVersion: 1, draft, source, ...(out === undefined ? {} : { written: out }) }, null, 2)}\n`,
    );
  else if (out === undefined) o.stdout(source);
  else {
    o.stdout(`Scenario drafted in ${relative(o.cwd, out) || out}\n`);
    for (const n of draft.notes) o.stdout(`  note: ${n}\n`);
  }
  return 0;
}
