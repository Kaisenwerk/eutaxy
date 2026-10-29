import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findSpecModules, specFiles, specKey } from "./specs.ts";

describe("findSpecModules and specFiles", () => {
  test("every spec file beside its module, read into specs; an orphan spec file is an error entry", () => {
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
      const modules = findSpecModules(dir);
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
