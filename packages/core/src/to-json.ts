/**
 * The one reduction of runtime values to JSON data for the effect log. It
 * never throws and reads the same on every machine (no locale or time zone).
 */

import type { JsonValue } from "./canonical-json.ts";

/** A platform's own encoding of an object, or undefined to use the default. */
export type JsonExtra = (value: object) => JsonValue | undefined;

const maxDepth = 10;

/**
 * Exact for JSON data. Otherwise: -0, NaN and the infinities as strings,
 * bigints as their digits, symbols as `Symbol(s)`, functions as `<function>`, Dates
 * as ISO strings, Sets as arrays, Maps as `[key, value]` pairs, Errors as
 * `Name: message`, byte buffers as `<bytes n>`, other objects by their own
 * enumerable keys; a cycle or nesting deeper than ten as `<nested>`, a
 * property that throws when read as `<unreadable>`. `extra` is tried first
 * on every object.
 */
export function toJson(value: unknown, extra?: JsonExtra): JsonValue {
  return walk(value, extra, 0, new Set());
}

function walk(
  value: unknown,
  extra: JsonExtra | undefined,
  depth: number,
  seen: Set<object>,
): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Object.is(value, -0)) return "-0";
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      // As D1 parameters and object values have always been logged, so selectors on them keep matching.
      return value.toString();
    case "symbol":
      return String(value);
    case "function":
      return "<function>";
  }
  const object = value as object;
  if (depth > maxDepth || seen.has(object)) return "<nested>";
  const own = extra?.(object);
  if (own !== undefined) return own;
  if (object instanceof Date)
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  if (object instanceof Error) return `${object.name}: ${object.message}`;
  if (object instanceof ArrayBuffer || ArrayBuffer.isView(object))
    return `<bytes ${object.byteLength}>`;
  const next = (v: unknown) => walk(v, extra, depth + 1, seen);
  seen.add(object);
  try {
    // Array.from, not map: a hole reads as undefined, so null, and canonical JSON allows no holes.
    if (Array.isArray(object)) return Array.from(object, next);
    if (object instanceof Set) return [...object].map(next);
    if (object instanceof Map) return [...object].map(([k, v]) => [next(k), next(v)]);
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(object)) {
      let v: JsonValue;
      try {
        v = next((object as Record<string, unknown>)[key]);
      } catch {
        v = "<unreadable>";
      }
      // Defined, not assigned: an own `__proto__` key stays a key.
      Object.defineProperty(out, key, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(object);
  }
}
