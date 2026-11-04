/**
 * The callees a scenario names (`callee()` steps), read on the Node side for
 * `eutaxy check`. Each callee's wrangler config gives its Worker's name and
 * its bindings; the command adds them to the test's isolate under qualified
 * names (`<name>/<binding>`): the main module it generates re-exports the
 * caller's exports as they are and the callees' Durable Object and Workflow
 * classes under qualified aliases, and the Vitest config's miniflare options
 * add the callees' resources. Probed inside workerd (2026-11): the plugin
 * takes a `main` beside the caller's `wrangler.configPath`, miniflare options
 * add to and override the wrangler config's bindings, and wrangler, miniflare
 * and workerd accept a slash in a binding name.
 */

import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonValue, ScenarioSpec } from "@eutaxy/core";
import { resolveAsTypeScript } from "./resolve.ts";

/** A `callee` setup step as the scenario holds it. */
export interface CalleeStep {
  readonly binding: string;
  readonly entry: string;
  readonly config: string;
  readonly entrypoint?: string;
}

/** What a callee's wrangler config says that the test's isolate must hold. */
export interface CalleeConfig {
  readonly binding: string;
  /** The Worker's name, which qualifies its bindings. */
  readonly name: string;
  /** The callee's module, absolute. */
  readonly entry: string;
  readonly d1: readonly { readonly binding: string; readonly id: string }[];
  readonly r2: readonly { readonly binding: string; readonly bucket: string }[];
  readonly kv: readonly { readonly binding: string; readonly id: string }[];
  readonly durableObjects: readonly {
    readonly binding: string;
    readonly className: string;
    readonly sqlite: boolean;
    /** The Worker whose script holds the class, when it is another's. */
    readonly scriptName?: string;
  }[];
  readonly workflows: readonly {
    readonly binding: string;
    readonly className: string;
    readonly name: string;
  }[];
  readonly services: readonly string[];
  readonly queues: readonly { readonly binding: string; readonly queue: string }[];
  readonly vars: Readonly<Record<string, JsonValue>>;
  /** The classes the migrations make SQLite-backed, bound by this Worker or not. */
  readonly sqliteClasses: readonly string[];
  /** Config the command does not carry into the isolate, named so the user knows. */
  readonly notAdded: readonly string[];
}

/** The `callee` steps of a setup, as the scenario wrote them. */
export function calleeSteps(setup: ScenarioSpec["setup"]): CalleeStep[] {
  return setup
    .filter((s) => s.kind === "callee")
    .map((s) => ({
      binding: String(s["binding"]),
      entry: String(s["entry"]),
      config: String(s["config"]),
      ...(s["entrypoint"] === undefined ? {} : { entrypoint: String(s["entrypoint"]) }),
    }));
}

/**
 * Whether the scenario's source names a callee at all: the command imports
 * the scenario module in Node only then, since reading its steps needs it.
 */
export function mentionsCallee(scenarioSource: string): boolean {
  return /\bcallee\s*\(/.test(scenarioSource);
}

/** What the command reads from the scenario module: its setup and its Worker. */
export type LoadedScenario = Pick<ScenarioSpec, "setup" | "worker">;

/** The argument that makes a process started on this module load one scenario and report it. */
const scenarioFlag = "--eutaxy-load-scenario";

type ScenarioOutput =
  | { readonly kind: "eutaxy-scenario"; readonly scenario: LoadedScenario }
  | { readonly kind: "eutaxy-scenario-error"; readonly message: string };

/** Inside the child: import the scenario and keep what the command reads. */
async function loadHere(scenarioPath: string): Promise<LoadedScenario> {
  resolveAsTypeScript();
  const mod = (await import(pathToFileURL(scenarioPath).href)) as { default?: ScenarioSpec };
  const spec = mod.default;
  if (!spec || !Array.isArray(spec.setup) || typeof spec.worker?.entry !== "string")
    throw new Error("the scenario module's default export is not a scenario");
  return { setup: spec.setup, worker: spec.worker };
}

const send = process.send?.bind(process);
if (process.argv[2] === scenarioFlag && send) {
  process.once("disconnect", () => process.exit(0));
  process.once("message", async (scenarioPath: string) => {
    let output: ScenarioOutput;
    try {
      output = { kind: "eutaxy-scenario", scenario: await loadHere(scenarioPath) };
    } catch (err) {
      output = { kind: "eutaxy-scenario-error", message: String(err) };
    }
    send(output, () => process.exit(0));
  });
}

/** How long a scenario module may take to load before the command gives up on it. */
const loadBudgetMs = 60_000;

/**
 * Import the scenario module in Node and return its setup and Worker, in a
 * child process started on this module (as `eutaxy report` loads modules):
 * a long-lived process (the MCP server) would otherwise get Node's cached
 * module after the scenario or what it imports changed. Relative imports
 * are resolved as TypeScript resolves them (`./setup.js` and `./setup` find
 * `setup.ts`). Rejects with what the import threw.
 */
export function loadScenario(scenarioPath: string): Promise<LoadedScenario> {
  return new Promise((resolveLoad, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [scenarioFlag], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    let errors = "";
    child.stderr?.on("data", (d: Buffer) => {
      errors += d.toString();
    });
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error(`the scenario module did not load within ${loadBudgetMs} ms`)));
    }, loadBudgetMs);
    child.on("message", (output: ScenarioOutput) => {
      settle(() => {
        if (output.kind === "eutaxy-scenario") resolveLoad(output.scenario);
        else reject(new Error(output.message));
      });
    });
    child.once("error", (err) => settle(() => reject(err)));
    child.once("close", (code, signal) =>
      settle(() =>
        reject(
          new Error(
            `the scenario module's process ended (${signal ?? `exit ${code}`}) before reporting${errors ? `:\n${errors}` : ""}`,
          ),
        ),
      ),
    );
    child.send(scenarioPath);
  });
}

/** The qualified names the callees' bindings get in the isolate, for a regression test's note. */
export function isolateBindings(callees: readonly CalleeConfig[]): string[] {
  const names: string[] = [];
  for (const c of callees) {
    for (const d of c.d1) names.push(qualified(c.name, d.binding));
    for (const b of c.r2) names.push(qualified(c.name, b.binding));
    for (const k of c.kv) names.push(qualified(c.name, k.binding));
    for (const o of c.durableObjects)
      if (o.scriptName === undefined) names.push(qualified(c.name, o.binding));
    for (const w of c.workflows) names.push(qualified(c.name, w.binding));
    for (const s of c.services) names.push(qualified(c.name, s));
    for (const q of c.queues) names.push(qualified(c.name, q.binding));
    for (const v of Object.keys(c.vars)) names.push(qualified(c.name, v));
  }
  return names;
}

/**
 * JSON with comments and trailing commas, as wrangler.jsonc allows: comments
 * are removed outside strings, a comma before `}` or `]` dropped, and the
 * rest is JSON.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  /** The index of the next character that is neither whitespace nor inside a comment, from `from`. */
  const nextToken = (from: number): number => {
    let k = from;
    for (;;) {
      while (k < text.length && /\s/.test(text[k] as string)) k++;
      if (text[k] === "/" && text[k + 1] === "/") {
        while (k < text.length && text[k] !== "\n") k++;
      } else if (text[k] === "/" && text[k + 1] === "*") {
        const end = text.indexOf("*/", k + 2);
        k = end < 0 ? text.length : end + 2;
      } else return k;
    }
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      // A trailing comma, outside strings only: dropped.
      const next = text[nextToken(i + 1)];
      if (next !== "}" && next !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/** Read a wrangler config as an object; only JSON and JSONC are read here. */
export function readWranglerConfig(path: string): Record<string, unknown> {
  const ext = extname(path);
  if (ext !== ".json" && ext !== ".jsonc")
    throw new Error(
      `${basename(path)}: eutaxy check reads a callee's wrangler config as JSON or JSONC; a TOML config is not read`,
    );
  const parsed = parseJsonc(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${basename(path)}: not a wrangler config object`);
  return parsed as Record<string, unknown>;
}

/** The `name` of a wrangler config, when the config can be read and names one. */
export function workerName(path: string): string | undefined {
  try {
    const name = readWranglerConfig(path)["name"];
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x) : [];
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** The keys of a wrangler config whose bindings the command carries into the isolate. */
const carried = new Set([
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "durable_objects",
  "migrations",
  "workflows",
  "services",
  "queues",
  "vars",
  "$schema",
  "observability",
  "triggers",
  "routes",
  "route",
  "workers_dev",
  "account_id",
  "placement",
  "limits",
  "upload_source_maps",
  "minify",
  "keep_vars",
  "preview_urls",
]);

/** Read a callee's wrangler config into what the isolate needs; `scenarioDir` resolves the step's paths. */
export function readCalleeConfig(step: CalleeStep, scenarioDir: string): CalleeConfig {
  const path = resolve(scenarioDir, step.config);
  const config = readWranglerConfig(path);
  const name = str(config["name"]);
  if (!name)
    throw new Error(
      `${basename(path)}: the callee's wrangler config has no name, which qualifies its bindings`,
    );
  const notAdded: string[] = [];
  // The migrations in order, as wrangler applies them: a class is SQLite-backed from the migration
  // that created it so, through renames, until one deletes it.
  const sqlite = new Set<string>();
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  for (const m of list(config["migrations"])) {
    for (const c of strings(m["new_sqlite_classes"])) sqlite.add(c);
    for (const r of list(m["renamed_classes"])) {
      const from = str(r["from"]);
      if (sqlite.delete(from)) sqlite.add(str(r["to"]));
    }
    for (const c of strings(m["deleted_classes"])) sqlite.delete(c);
  }
  const durableObjects: CalleeConfig["durableObjects"][number][] = [];
  const dos = config["durable_objects"] as { bindings?: unknown } | undefined;
  for (const b of list(dos?.bindings)) {
    const className = str(b["class_name"]);
    const scriptName = b["script_name"] === undefined ? undefined : str(b["script_name"]);
    durableObjects.push({
      binding: str(b["name"]),
      className,
      sqlite: sqlite.has(className),
      ...(scriptName === undefined ? {} : { scriptName }),
    });
  }
  const queues = config["queues"] as { producers?: unknown } | undefined;
  for (const key of Object.keys(config)) if (!carried.has(key)) notAdded.push(key);
  const vars: Record<string, JsonValue> = {};
  const rawVars = config["vars"];
  if (typeof rawVars === "object" && rawVars !== null)
    for (const [k, v] of Object.entries(rawVars as Record<string, JsonValue>)) vars[k] = v;
  return {
    binding: step.binding,
    name,
    entry: resolve(scenarioDir, step.entry),
    d1: list(config["d1_databases"]).map((d) => ({
      binding: str(d["binding"]),
      id: str(d["database_id"], str(d["database_name"], str(d["binding"]))),
    })),
    r2: list(config["r2_buckets"]).map((b) => ({
      binding: str(b["binding"]),
      bucket: str(b["bucket_name"], str(b["binding"])),
    })),
    kv: list(config["kv_namespaces"]).map((k) => ({
      binding: str(k["binding"]),
      id: str(k["id"], str(k["binding"])),
    })),
    durableObjects,
    workflows: list(config["workflows"]).map((w) => ({
      binding: str(w["binding"]),
      className: str(w["class_name"]),
      name: str(w["name"], str(w["binding"])),
    })),
    services: list(config["services"]).map((s) => str(s["binding"])),
    queues: list(queues?.producers).map((p) => ({
      binding: str(p["binding"]),
      queue: str(p["queue"]),
    })),
    vars,
    sqliteClasses: [...sqlite],
    notAdded,
  };
}

/** A Worker's name as an identifier prefix (`my-worker` → `my_worker`, `1st` → `_1st`). */
const ident = (s: string): string => {
  const safe = s.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(safe) ? safe : `_${safe}`;
};

/** The export name a callee's class gets in the generated main module. */
export function classAlias(worker: string, className: string): string {
  return `${ident(worker)}__${className}`;
}

/** The qualified name of a callee's binding. */
export function qualified(worker: string, binding: string): string {
  return `${worker}/${binding}`;
}

function toPosix(p: string): string {
  const s = p.split("\\").join("/");
  return s.startsWith(".") ? s : `./${s}`;
}

/**
 * The main module the plugin runs: the caller's exports as they are, and
 * each callee's Durable Object and Workflow classes under qualified aliases,
 * so the miniflare options can bind them. workerd constructs those classes
 * with the main Worker's env, so each alias is a subclass handing its parent
 * the callee's view of it (`calleeEnv`), under which `this.env.DB` is the
 * callee's `<name>/DB`.
 */
export function mainModuleSource(
  workDir: string,
  callerEntry: string,
  callees: readonly CalleeConfig[],
  isolate: ReturnType<typeof isolateOf> = noIsolate,
): string {
  const caller = toPosix(relative(workDir, callerEntry));
  const lines = [
    "// Generated by eutaxy check; deleted after the run.",
    `export * from ${JSON.stringify(caller)};`,
    `export { default } from ${JSON.stringify(caller)};`,
  ];
  const adapters: string[] = [];
  // Two bindings may reach one Worker (two entrypoints of it): one adapter per Worker and class.
  const emitted = new Set<string>();
  callees.forEach((c, i) => {
    const classes = [
      ...c.durableObjects.filter((d) => d.scriptName === undefined).map((d) => d.className),
      ...c.workflows.map((w) => w.className),
      // Classes of this script the caller binds, which the callee binds nowhere itself.
      ...(isolate.extraClasses[c.name] ?? []),
    ];
    const unique = [...new Set(classes)].filter((n) => n && !emitted.has(classAlias(c.name, n)));
    if (unique.length === 0) return;
    lines.push(
      `import { ${unique.map((n) => `${n} as callee${i}_${n}`).join(", ")} } from ${JSON.stringify(toPosix(relative(workDir, c.entry)))};`,
    );
    // The aliases of this callee's bindings: workerd constructs the class with the raw env, where an alias
    // has no key of its own, so the view resolves them.
    const own = Object.fromEntries(
      Object.entries(isolate.aliases).filter(([k]) => k.startsWith(`${c.name}/`)),
    );
    const view = `calleeEnv(${JSON.stringify(c.name)}, env${Object.keys(own).length === 0 ? "" : `, ${JSON.stringify(own)}`})`;
    for (const n of unique) {
      emitted.add(classAlias(c.name, n));
      adapters.push(
        `export class ${classAlias(c.name, n)} extends callee${i}_${n} {`,
        `  constructor(ctx: unknown, env: object) {`,
        `    super(ctx as never, ${view} as never);`,
        `  }`,
        `}`,
      );
    }
  });
  if (adapters.length > 0) lines.splice(1, 0, 'import { calleeEnv } from "eutaxy/cloudflare";');
  return `${[...lines, ...adapters].join("\n")}\n`;
}

/** The name the generated config gives the function answering a service binding nobody calls. */
export const neverCalled = "neverCalled";

/**
 * The miniflare options adding the callees' resources under qualified names,
 * as source (an object literal) for the generated Vitest config. Service
 * bindings, the caller's to its callees and the callees' own, are answered
 * by a function of the config's (`neverCalled`): the Worker the caller's
 * config names is not in the isolate, a worker name given through these
 * options must be one the plugin knows, and the binding is never called
 * anyway (the scenario names a callee for it or scripts it); its value is a
 * Fetcher all the same, which is what the platform recognises.
 */
export function miniflareOptionsSource(
  callees: readonly CalleeConfig[],
  isolate: ReturnType<typeof isolateOf> = noIsolate,
): string {
  const d1: Record<string, string> = {};
  const r2: Record<string, string> = {};
  const kv: Record<string, string> = {};
  const dos: Record<string, { className: string; useSQLite?: boolean }> = {};
  const workflows: Record<string, { name: string; className: string }> = {};
  const services: Record<string, string> = {};
  const queues: Record<string, string> = {};
  const vars: Record<string, JsonValue> = {};
  // An alias is a second name of the caller's binding in env, which the platform gives it: nothing to add.
  const aliased = (name: string): boolean => name in isolate.aliases;
  Object.assign(dos, isolate.redirected);
  for (const c of callees) {
    for (const d of c.d1)
      if (!aliased(qualified(c.name, d.binding))) d1[qualified(c.name, d.binding)] = d.id;
    for (const b of c.r2)
      if (!aliased(qualified(c.name, b.binding))) r2[qualified(c.name, b.binding)] = b.bucket;
    for (const k of c.kv)
      if (!aliased(qualified(c.name, k.binding))) kv[qualified(c.name, k.binding)] = k.id;
    for (const o of c.durableObjects) {
      // A class of another Worker's script is that Worker's: an alias when it is the caller's (see
      // `isolateOf`), not added otherwise.
      if (o.scriptName !== undefined || aliased(qualified(c.name, o.binding))) continue;
      dos[qualified(c.name, o.binding)] = {
        className: classAlias(c.name, o.className),
        ...(o.sqlite ? { useSQLite: true } : {}),
      };
    }
    for (const w of c.workflows)
      workflows[qualified(c.name, w.binding)] = {
        name: w.name,
        className: classAlias(c.name, w.className),
      };
    services[c.binding] = neverCalled;
    for (const s of c.services) services[qualified(c.name, s)] = neverCalled;
    for (const q of c.queues) queues[qualified(c.name, q.binding)] = q.queue;
    for (const [k, v] of Object.entries(c.vars)) vars[qualified(c.name, k)] = v;
  }
  const options: Record<string, object> = {};
  const add = (key: string, value: object) => {
    if (Object.keys(value).length > 0) options[key] = value;
  };
  add("d1Databases", d1);
  add("r2Buckets", r2);
  add("kvNamespaces", kv);
  add("durableObjects", dos);
  add("workflows", workflows);
  add("queueProducers", queues);
  add("bindings", vars);
  // JSON for the data, which is also an object literal; the service bindings name the config's function.
  const data = JSON.stringify(options);
  const bindings = Object.keys(services);
  if (bindings.length === 0) return data;
  const literal = `"serviceBindings":{${bindings.map((b) => `${JSON.stringify(b)}:${neverCalled}`).join(",")}}`;
  return data === "{}" ? `{${literal}}` : `${data.slice(0, -1)},${literal}}`;
}

/** What the caller's config says that the isolate must reconcile with the callees'. */
export interface CallerResources {
  readonly name: string | undefined;
  readonly d1: readonly { readonly binding: string; readonly id: string }[];
  readonly r2: readonly { readonly binding: string; readonly bucket: string }[];
  readonly kv: readonly { readonly binding: string; readonly id: string }[];
  readonly durableObjects: readonly {
    readonly binding: string;
    readonly className: string;
    readonly scriptName?: string;
  }[];
  /** The caller's service bindings: the entrypoint each reaches and the props it carries, when set. */
  readonly services: readonly {
    readonly binding: string;
    readonly entrypoint?: string;
    readonly props?: Readonly<Record<string, JsonValue>>;
  }[];
}

/** The caller's resources from its wrangler config, when the config can be read (JSON or JSONC); none otherwise. */
export function readCallerResources(wranglerPath: string): CallerResources | undefined {
  try {
    const config = readWranglerConfig(wranglerPath);
    const dos = config["durable_objects"] as { bindings?: unknown } | undefined;
    return {
      name: str(config["name"]) || undefined,
      d1: list(config["d1_databases"]).map((d) => ({
        binding: str(d["binding"]),
        id: str(d["database_id"], str(d["database_name"], str(d["binding"]))),
      })),
      r2: list(config["r2_buckets"]).map((b) => ({
        binding: str(b["binding"]),
        bucket: str(b["bucket_name"], str(b["binding"])),
      })),
      kv: list(config["kv_namespaces"]).map((k) => ({
        binding: str(k["binding"]),
        id: str(k["id"], str(k["binding"])),
      })),
      durableObjects: list(dos?.bindings).map((b) => ({
        binding: str(b["name"]),
        className: str(b["class_name"]),
        ...(b["script_name"] === undefined ? {} : { scriptName: str(b["script_name"]) }),
      })),
      services: list(config["services"]).map((b) => ({
        binding: str(b["binding"]),
        ...(typeof b["entrypoint"] === "string" ? { entrypoint: b["entrypoint"] } : {}),
        ...(typeof b["props"] === "object" && b["props"] !== null
          ? { props: b["props"] as Record<string, JsonValue> }
          : {}),
      })),
    };
  } catch {
    return undefined;
  }
}

/** What the caller's binding to a callee carries (its entrypoint and props), for the test to pass with the module. */
export function bindingCarries(
  caller: CallerResources | undefined,
  binding: string,
): { readonly entrypoint?: string; readonly props?: Readonly<Record<string, JsonValue>> } {
  const s = caller?.services.find((x) => x.binding === binding);
  return {
    ...(s?.entrypoint === undefined ? {} : { entrypoint: s.entrypoint }),
    ...(s?.props === undefined ? {} : { props: s.props }),
  };
}

/**
 * The isolate's shared resources, from the two configs: a callee binding
 * that names a resource the caller binds too (the same `database_id`,
 * `bucket_name` or KV `id`; a Durable Object class of the caller's script,
 * or a caller binding to a class of the callee's script) is an alias of the
 * caller's binding, set up and snapshotted under the caller's name; a
 * caller's binding to a callee's class is redirected to the generated alias
 * class. What a callee binds in a third Worker's script is named as not
 * added.
 */
export function isolateOf(
  callees: readonly CalleeConfig[],
  caller: CallerResources | undefined,
): {
  /** Qualified name → the caller's binding it is an alias of. */
  readonly aliases: Readonly<Record<string, string>>;
  /** The caller's own bindings redirected to a callee's class, as miniflare `durableObjects` entries. */
  readonly redirected: Readonly<Record<string, { className: string; useSQLite?: boolean }>>;
  /** Per callee name, classes of its script the caller binds that the callee binds nowhere itself: the main module exports them too. */
  readonly extraClasses: Readonly<Record<string, readonly string[]>>;
  readonly notAdded: readonly string[];
} {
  const aliases: Record<string, string> = {};
  const redirected: Record<string, { className: string; useSQLite?: boolean }> = {};
  const extraClasses: Record<string, string[]> = {};
  const notAdded: string[] = [];
  // A caller config that already declares the callee's binding under its qualified name (for a test
  // of its own) names nothing else: no alias.
  const alias = (name: string, own: string) => {
    if (own !== name) aliases[name] = own;
  };
  for (const c of callees) {
    if (caller) {
      for (const d of c.d1) {
        const own = caller.d1.find((x) => x.id === d.id);
        if (own) alias(qualified(c.name, d.binding), own.binding);
      }
      for (const b of c.r2) {
        const own = caller.r2.find((x) => x.bucket === b.bucket);
        if (own) alias(qualified(c.name, b.binding), own.binding);
      }
      for (const k of c.kv) {
        const own = caller.kv.find((x) => x.id === k.id);
        if (own) alias(qualified(c.name, k.binding), own.binding);
      }
      // The caller binds a class of this callee's script: its binding is the class's alias; the
      // callee's own binding of that class is an alias of the caller's.
      for (const o of caller.durableObjects) {
        if (o.scriptName !== c.name) continue;
        const theirs = c.durableObjects.find(
          (x) => x.className === o.className && x.scriptName === undefined,
        );
        redirected[o.binding] = {
          className: classAlias(c.name, o.className),
          ...(c.sqliteClasses.includes(o.className) ? { useSQLite: true } : {}),
        };
        if (theirs) alias(qualified(c.name, theirs.binding), o.binding);
        else {
          const extra = extraClasses[c.name] ?? [];
          extra.push(o.className);
          extraClasses[c.name] = extra;
        }
      }
    }
    for (const o of c.durableObjects) {
      if (o.scriptName === undefined) continue;
      // A class of the caller's script: the callee's binding is an alias of the caller's binding to it.
      const own =
        caller && o.scriptName === caller.name
          ? caller.durableObjects.find(
              (x) => x.className === o.className && x.scriptName === undefined,
            )
          : undefined;
      if (own) alias(qualified(c.name, o.binding), own.binding);
      else
        notAdded.push(
          `${c.binding}: durable_objects binding ${o.binding} (script_name ${o.scriptName}: a class of another Worker)`,
        );
    }
  }
  return { aliases, redirected, extraClasses, notAdded };
}

/** An isolate with nothing shared. */
export const noIsolate: ReturnType<typeof isolateOf> = {
  aliases: {},
  redirected: {},
  extraClasses: {},
  notAdded: [],
};

/** Where a callee's config path and entry sit, for messages. */
export function describeCallee(c: CalleeConfig, scenarioDir: string): string {
  return `${c.binding} (${c.name}, ${toPosix(relative(scenarioDir, c.entry))})`;
}
