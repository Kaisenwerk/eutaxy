import { extractSpecs } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { specFiles, specKey } from "./specs.ts";

describe("specsModuleSource", () => {
  test("each predicate binds its free names from the namespace, under names nothing shadows", () => {
    const specs = extractSpecs(`
export { limit } from "./limits.ts";
export const __eutaxyBool = 2;
/** @ensures{p} forall (x: int) { x + limit > x ∧ __eutaxyBool === 2 } */
export function f(x: number) { return x; }
`);
    const files = specFiles([{ key: "./m.ts", path: "/m.ts", specs }]);
    const source = files.find((f) => f.name === "specs/m0.ts")?.source ?? "";
    expect(source).toContain('const limit = "limit" in __scope ? __scope["limit"]');
    expect(source).toContain('const __eutaxyBool = "__eutaxyBool" in __scope');
    expect(source).toContain(
      "})(__eutaxyBool, __eutaxySame, __eutaxyNamespace, __eutaxyUnresolved)",
    );
  });

  test("each module's predicates are their own file, loaded only when a scenario names the module", () => {
    const specs = extractSpecs(
      "/** @ensures{p} forall (x: int) { x === x } */\nexport function f(x: number) {}",
    );
    const files = specFiles([
      { key: "./a.ts", path: "/a.ts", specs },
      { key: "./b.ts", path: "/b.ts", specs },
    ]);
    expect(files.map((f) => f.name)).toEqual(["specs.ts", "specs/m0.ts", "specs/m1.ts"]);
    const index = files[0]?.source ?? "";
    expect(index).toContain('"./a.ts": () => import("./specs/m0.ts")');
    expect(index).not.toContain("forall");
  });

  test("names like __proto__ stay ordinary entries", () => {
    const specs = extractSpecs(
      "/** @ensures{__proto__} forall (x: int) { x > 0 } */\nexport function __proto__(x: number) {}",
    );
    const source = specFiles([{ key: "./m.ts", path: "/m.ts", specs }])[1]?.source ?? "";
    expect(source).toContain('["__proto__"]: {');
    expect(source).toContain('["__proto__"]: ((');
  });

  test("keys normalize the way a scenario names a module", () => {
    expect(specKey("domain.ts")).toBe("./domain.ts");
    expect(specKey("././core/domain.ts")).toBe("./core/domain.ts");
  });
});
