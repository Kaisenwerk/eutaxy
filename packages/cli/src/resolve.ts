/**
 * Relative imports from a `.ts` file that Node cannot resolve are tried as
 * TypeScript resolves them, so `./domain.js` and `./domain` find `domain.ts`
 * (or `domain/index.ts`), as `tsc` and Vite would. Used where the command
 * imports a user's module in Node: `eutaxy report` for spec modules, `eutaxy
 * check` for a scenario that names callees.
 */

import { registerHooks } from "node:module";

let registered = false;

/** Register the hook once per process. */
export function resolveAsTypeScript(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !context.parentURL?.endsWith(".ts")) throw err;
        const stem = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
        for (const candidate of [`${stem}.ts`, `${stem}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {}
        }
        throw err;
      }
    },
  });
}
