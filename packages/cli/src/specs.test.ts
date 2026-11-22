import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findSpecModules, specFiles, specKey, typescriptMissing } from "./specs.ts";

describe("findSpecModules and specFiles", () => {
  test("every spec file beside its module, read into specs; an orphan spec file is an error entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eutaxy-specs-"));
    try {
      mkdirSync(join(dir, "core"));
      writeFileSync(
        join(dir, "core", "domain.ts"),
        "export function f(x: number): number { return x; }\n",
      );
      writeFileSync(
        join(dir, "core", "domain.props.ts"),
        'import { forall } from "eutaxy/spec";\nimport { f } from "./domain";\nexport const p = forall(f, { ensures: (x) => f(x) === x });\n',
      );
      writeFileSync(join(dir, "orphan.props.ts"), "export const nothing = 1;\n");
      writeFileSync(join(dir, "scenario.sim.ts"), "export default {};\n");
      const modules = await findSpecModules(dir);
      expect(modules.map((m) => m.key)).toEqual(["./core/domain.ts", "./orphan.ts"]);
      expect(modules[0]?.specs.functions[0]?.properties[0]?.name).toBe("p");
      expect(modules[0]?.specs.errors).toEqual([]);
      expect(modules[1]?.specs.errors[0]?.message).toContain("has no module orphan.ts beside it");
      const files = specFiles(modules, join(dir, ".eutaxy"));
      expect(files.map((f) => f.name)).toEqual(["specs.ts"]);
      const source = files[0]?.source ?? "";
      expect(source).toContain('"./core/domain.ts": { specs: {"functions":[{"name":"f"');
      expect(source).toContain('load: () => import("../core/domain.props.ts")');
      // The entries are plain data and lazy loaders; the file imports nothing of its own.
      expect(source).not.toMatch(/^import /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keys normalize the way a scenario names a module", () => {
    expect(specKey("domain.ts")).toBe("./domain.ts");
    expect(specKey("././core/domain.ts")).toBe("./core/domain.ts");
  });
});

describe("typescriptMissing", () => {
  const failed = (message: string, code = "ERR_MODULE_NOT_FOUND") =>
    Object.assign(new Error(message), { code });

  test("no compiler installed: Node finds no package of that name", () => {
    expect(
      typescriptMissing(failed("Cannot find package 'typescript' imported from /p/x.js")),
    ).toBe(true);
  });

  test("an older compiler: its package lacks the export, or the file, the reader imports", () => {
    expect(
      typescriptMissing(
        failed(
          `Package subpath './sync' is not defined by "exports" in /p/node_modules/typescript/package.json imported from /p/x.js`,
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
        ),
      ),
    ).toBe(true);
    expect(
      typescriptMissing(
        failed("Cannot find module '/p/node_modules/typescript/ast' imported from /p/x.js"),
      ),
    ).toBe(true);
  });

  test("not another missing package, another error, or a package whose name only starts the same", () => {
    expect(typescriptMissing(failed("Cannot find package 'vitest' imported from /p/x.js"))).toBe(
      false,
    );
    expect(
      typescriptMissing(failed("Cannot find package 'typescript-eslint' imported from /p/x.js")),
    ).toBe(false);
    expect(
      typescriptMissing(
        failed(
          "Cannot find module '/p/node_modules/typescript-eslint/dist/x.js' imported from /p/y",
        ),
      ),
    ).toBe(false);
    expect(typescriptMissing(failed("Cannot find package 'typescript'", "ERR_OTHER"))).toBe(false);
    expect(typescriptMissing(new Error("boom"))).toBe(false);
    expect(typescriptMissing(undefined)).toBe(false);
  });
});
