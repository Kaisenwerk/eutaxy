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

/** Read a dot path such as "args.params.0" out of JSON data; undefined when absent. */
export function getPath(value: JsonValue, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  if (path === "") return cur;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0) return undefined;
      cur = cur[i];
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

export function matches(record: EffectRecord, sel: EffectSelector): boolean {
  if (record.target !== sel.target) return false;
  if (sel.op !== undefined && record.op !== sel.op) return false;
  if (sel.kind !== undefined && record.kind !== sel.kind) return false;
  if (sel.where) {
    for (const [path, want] of Object.entries(sel.where)) {
      if (!jsonEqual(getPath(record.payload, path), want)) return false;
    }
  }
  if (sel.atLeast) {
    for (const [path, min] of Object.entries(sel.atLeast)) {
      const v = getPath(record.payload, path);
      if (typeof v !== "number" || v < min) return false;
    }
  }
  return true;
}

export function selectEffects(log: EffectLog, sel: EffectSelector): readonly EffectRecord[] {
  return log.entries.filter((e) => matches(e, sel));
}

/** Canonical form of a key, so equal JSON values compare equal whatever their key order. */
export function keyOf(record: EffectRecord, path: string): string | undefined {
  const v = getPath(record.payload, path);
  return v === undefined ? undefined : canonicalJson(v);
}
