// A project without the TypeScript compiler, for the command's tests: preloaded with --import, it makes
// every import of `typescript` fail as Node fails one of a package that is not installed.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typescript" || specifier.startsWith("typescript/")) {
      const err = new Error(
        `Cannot find package 'typescript' imported from ${context.parentURL ?? "the command"}`,
      );
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    }
    return nextResolve(specifier, context);
  },
});
