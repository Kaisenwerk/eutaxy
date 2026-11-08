/** Picking effect records out of the log, and reading paths out of their payloads. */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { EffectKind, EffectLog, EffectRecord } from "./effect-log.ts";

/** Picks effect records by target, op, kind and payload fields. */
export interface EffectSelector {
  readonly target: string;
  readonly op?: string;
  readonly kind?: EffectKind;
  /** Dot paths into the payload that must equal the given values. */
  readonly where?: { readonly [path: string]: JsonValue };
  /** Dot paths into the payload whose numeric value must be at least the given bound. */
  readonly atLeast?: { readonly [path: string]: number };
}

/** A dot path split once, so a selector applied to many records does not split it per record. */
type PathParts = readonly string[];
const partsOf = (path: string): PathParts => (path === "" ? [] : path.split("."));
const indexPattern = /^(0|[1-9]\d*)$/;

/** Read a dot path such as "args.params.0" out of JSON data; undefined when absent. */
export function getPath(value: JsonValue, path: string): JsonValue | undefined {
  return readParts(value, partsOf(path));
}

function readParts(value: JsonValue, parts: PathParts): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      // Only a plain index reads an array: "", " 1" or "1e0" would also convert to a number.
      if (!indexPattern.test(part)) return undefined;
      cur = cur[Number(part)];
    } else {
      cur = (cur as { readonly [k: string]: JsonValue })[part];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function jsonEqual(a: JsonValue | undefined, b: JsonValue): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i] as JsonValue));
  }
  const ao = a as { readonly [k: string]: JsonValue };
  const bo = b as { readonly [k: string]: JsonValue };
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i] && jsonEqual(ao[k], bo[k] as JsonValue))
  );
}

/** A selector prepared once (its paths split, its conditions listed) for the records it is tried on. */
export type EffectPredicate = (record: EffectRecord) => boolean;

export function compileSelector(sel: EffectSelector): EffectPredicate {
  const where = Object.entries(sel.where ?? {}).map(([p, want]) => [partsOf(p), want] as const);
  const atLeast = Object.entries(sel.atLeast ?? {}).map(([p, min]) => [partsOf(p), min] as const);
  return (record) => {
    if (record.target !== sel.target) return false;
    if (sel.op !== undefined && record.op !== sel.op) return false;
    if (sel.kind !== undefined && record.kind !== sel.kind) return false;
    for (const [parts, want] of where)
      if (!jsonEqual(readParts(record.payload, parts), want)) return false;
    for (const [parts, min] of atLeast) {
      const v = readParts(record.payload, parts);
      if (typeof v !== "number" || v < min) return false;
    }
    return true;
  };
}

export function selectEffects(log: EffectLog, sel: EffectSelector): readonly EffectRecord[] {
  return log.entries.filter(compileSelector(sel));
}

/** Canonical form of a key, so equal JSON values compare equal whatever their key order. */
export function keyOf(record: EffectRecord, path: string): string | undefined {
  const v = getPath(record.payload, path);
  return v === undefined ? undefined : canonicalJson(v);
}
