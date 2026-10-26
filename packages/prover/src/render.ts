/** A value as a JavaScript literal, exact for the primitive types (bigints included), JSON for records. */
export function render(value: unknown): string {
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
  }
  try {
    const text = JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

/** Whether two values render alike: structural equality that tells `1n` from `1` and `-0` from `0`. */
export function same(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && render(a) === render(b);
}
