/**
 * Canonical JSON: the one serialisation of a value, so that equal data always
 * produces equal bytes. Object keys are sorted; numbers must be finite; there
 * is no whitespace. Anything that is not plain JSON data is rejected.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number: ${value}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const v = value[i];
          if (v === undefined) throw new TypeError(`hole or undefined at index ${i}`);
          items.push(canonicalJson(v));
        }
        return `[${items.join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = (value as { readonly [key: string]: JsonValue | undefined })[k];
        if (v === undefined) throw new TypeError(`undefined at key ${JSON.stringify(k)}`);
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`not JSON data: ${typeof value}`);
  }
}
