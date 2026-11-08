/**
 * Wrangler config reading, one copy for `check` and `draft`: JSON and JSONC
 * parsing, the bindings a config declares, and the rules that name their
 * resources (a D1 database's id, an R2 bucket's name, a KV namespace's id,
 * which Durable Object classes are SQLite-backed). Only JSON and JSONC are
 * read; a TOML config is refused.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { JsonValue } from "@eutaxy/core";

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

/** Read a wrangler config as an object; only JSON and JSONC are read. */
export function readWranglerConfig(path: string): Record<string, unknown> {
  const ext = extname(path);
  if (ext !== ".json" && ext !== ".jsonc")
    throw new Error(
      `${basename(path)}: eutaxy reads a wrangler config as JSON or JSONC; a TOML config is not read`,
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

/** The object entries of a config list; anything else is no entry. */
export const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x) : [];
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A D1 binding's database: its id, else its name, else the binding (the same database in two configs is one). */
export const d1Id = (db: Record<string, unknown>): string =>
  str(db["database_id"], str(db["database_name"], str(db["binding"])));
/** An R2 binding's bucket: its name, else the binding. */
export const r2Bucket = (b: Record<string, unknown>): string =>
  str(b["bucket_name"], str(b["binding"]));
/** A KV binding's namespace: its id, else the binding. */
export const kvId = (k: Record<string, unknown>): string => str(k["id"], str(k["binding"]));

/**
 * The SQLite-backed Durable Object classes of a config, with its migrations applied in order as
 * wrangler applies them: a class is SQLite-backed from the migration that created it so, through
 * renames, until one deletes it.
 */
export function sqliteClasses(config: Record<string, unknown>): Set<string> {
  const sqlite = new Set<string>();
  for (const m of list(config["migrations"])) {
    for (const c of strings(m["new_sqlite_classes"])) sqlite.add(c);
    for (const r of list(m["renamed_classes"])) {
      const from = str(r["from"]);
      if (sqlite.delete(from)) sqlite.add(str(r["to"]));
    }
    for (const c of strings(m["deleted_classes"])) sqlite.delete(c);
  }
  return sqlite;
}

/** The bindings a wrangler config declares, each resource named by the rules above. */
export interface WranglerBindings {
  readonly name: string | undefined;
  readonly main: string | undefined;
  readonly d1: readonly { readonly binding: string; readonly id: string }[];
  readonly r2: readonly { readonly binding: string; readonly bucket: string }[];
  readonly kv: readonly { readonly binding: string; readonly id: string }[];
  readonly durableObjects: readonly {
    readonly binding: string;
    readonly className: string;
    readonly sqlite: boolean;
    /** Another Worker's script, when the class is its. */
    readonly scriptName?: string;
  }[];
  readonly workflows: readonly {
    readonly binding: string;
    readonly className: string;
    readonly name: string;
  }[];
  /** The service bindings: the Worker each names, the entrypoint it reaches and the props it carries, when set. */
  readonly services: readonly {
    readonly binding: string;
    readonly service: string;
    readonly entrypoint?: string;
    readonly props?: Readonly<Record<string, JsonValue>>;
  }[];
  readonly queues: readonly { readonly binding: string; readonly queue: string }[];
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly sqliteClasses: readonly string[];
  /** Every top-level key of the config. */
  readonly keys: readonly string[];
}

/** Read a config's bindings. */
export function readBindings(config: Record<string, unknown>): WranglerBindings {
  const sqlite = sqliteClasses(config);
  const dos = config["durable_objects"] as { bindings?: unknown } | undefined;
  const queues = config["queues"] as { producers?: unknown } | undefined;
  const vars: Record<string, JsonValue> = {};
  const rawVars = config["vars"];
  if (typeof rawVars === "object" && rawVars !== null)
    for (const [k, v] of Object.entries(rawVars as Record<string, JsonValue>)) vars[k] = v;
  return {
    name: str(config["name"]) || undefined,
    main: str(config["main"]) || undefined,
    d1: list(config["d1_databases"]).map((d) => ({ binding: str(d["binding"]), id: d1Id(d) })),
    r2: list(config["r2_buckets"]).map((b) => ({
      binding: str(b["binding"]),
      bucket: r2Bucket(b),
    })),
    kv: list(config["kv_namespaces"]).map((k) => ({ binding: str(k["binding"]), id: kvId(k) })),
    durableObjects: list(dos?.bindings).map((b) => {
      const className = str(b["class_name"]);
      return {
        binding: str(b["name"]),
        className,
        sqlite: sqlite.has(className),
        ...(b["script_name"] === undefined ? {} : { scriptName: str(b["script_name"]) }),
      };
    }),
    workflows: list(config["workflows"]).map((w) => ({
      binding: str(w["binding"]),
      className: str(w["class_name"]),
      name: str(w["name"], str(w["binding"])),
    })),
    services: list(config["services"]).map((s) => ({
      binding: str(s["binding"]),
      service: str(s["service"]),
      ...(typeof s["entrypoint"] === "string" ? { entrypoint: s["entrypoint"] } : {}),
      ...(typeof s["props"] === "object" && s["props"] !== null
        ? { props: s["props"] as Record<string, JsonValue> }
        : {}),
    })),
    queues: list(queues?.producers).map((p) => ({
      binding: str(p["binding"]),
      queue: str(p["queue"]),
    })),
    vars,
    sqliteClasses: [...sqlite],
    keys: Object.keys(config),
  };
}
