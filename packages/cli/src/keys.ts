/** How the two halves of `eutaxy check` name a module next to the scenario. Imports nothing, so workerd can load it. */

/** Normalize a module path from a scenario's `specs` to a key: "./domain.ts". */
export function specKey(path: string): string {
  const posix = path
    .split("\\")
    .join("/")
    .replace(/^(\.\/)+/, "");
  return `./${posix}`;
}

/** The key Vite's `import.meta.glob` gives a path next to the scenario, seen from `.eutaxy/`. */
export function globKey(path: string): string {
  return `.${specKey(path)}`;
}
