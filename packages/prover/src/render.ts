/**
 * A value as a JavaScript literal: exact for the primitive types (bigints
 * included, `-0` and `NaN` kept), records and arrays spelled as literals,
 * so a counterexample reads back as what it was. Never truncated and never
 * throwing: the rungs key distinct inputs by it, so two values must render
 * alike only when they are alike.
 */
export function render(value: unknown): string {
  return renderAt(value, new Set());
}

function renderAt(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "bigint":
      return `${value}n`;
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "boolean":
      return String(value);
    case "function":
      return "[function]";
    case "symbol":
      return String(value);
  }
  if (value === null) return "null";
  const o = value as object;
  if (seen.has(o)) return "<cycle>";
  seen.add(o);
  try {
    if (Array.isArray(o)) return `[${o.map((x) => renderAt(x, seen)).join(", ")}]`;
    if (o instanceof Date)
      return Number.isNaN(o.getTime()) ? "Date(NaN)" : `Date(${JSON.stringify(o.toISOString())})`;
    if (o instanceof Map)
      return `Map([${[...o].map(([k, v]) => `[${renderAt(k, seen)}, ${renderAt(v, seen)}]`).join(", ")}])`;
    if (o instanceof Set) return `Set([${[...o].map((x) => renderAt(x, seen)).join(", ")}])`;
    const entries = Object.entries(o).map(
      ([k, v]) =>
        `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${renderAt(v, seen)}`,
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  } catch {
    // A throwing getter or an exotic object: something, never a throw out of a verdict.
    try {
      return `<${String(o)}>`;
    } catch {
      return "<unrenderable>";
    }
  } finally {
    seen.delete(o);
  }
}

/** Whether two values render alike: structural equality that tells `1n` from `1` and `-0` from `0`. */
export function same(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && render(a) === render(b);
}
