import type { JsonValue } from "@eutaxy/core";

/** Reduce any runtime value to JSON data for the effect log; never throws. */
export function toJson(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "object": {
      if (depth > 8) return "<nested>";
      if (Array.isArray(value)) return value.map((v) => toJson(v, depth + 1));
      if (value instanceof ArrayBuffer) return `<bytes ${value.byteLength}>`;
      if (ArrayBuffer.isView(value)) return `<bytes ${value.byteLength}>`;
      if (value instanceof Date) return value.toISOString();
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(value).sort()) {
        out[k] = toJson((value as Record<string, unknown>)[k], depth + 1);
      }
      return out;
    }
    default:
      return `<${typeof value}>`;
  }
}
