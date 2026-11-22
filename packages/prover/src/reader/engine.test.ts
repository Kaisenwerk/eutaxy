/**
 * A module read for an engine (`readForEngine`): the functions asked for,
 * the engine's restrictions applied in order, and the functions outside
 * with why, which is the reading both first-party engines open with.
 */
import { describe, expect, test } from "vitest";
import { proofsOf, unknownOutcome } from "../provers.ts";
import { type EngineRestriction, engineGap, outsideProofs, readForEngine } from "./engine.ts";
import { readSpecs } from "./specs.ts";
import { listKinds } from "./tree.ts";

const read = (module: string, spec: string) =>
  readSpecs({ module, spec, modulePath: "/virtual/domain.ts" });

const source = [
  "export function mod(x: number): number {",
  "  return x % 1;",
  "}",
  "export function id(x: number): number { return x; }",
  "export function first(xs: readonly number[]): number { return xs.length === 0 ? 0 : xs[0] ?? 0; }",
  "export function orZero(x: number | null): number { return x === null ? 0 : x; }",
].join("\n");
const spec = [
  'import { forall } from "eutaxy/spec";',
  'import { first, id, mod, orZero } from "./domain.ts";',
  "export const p = forall(mod, { ensures: (x) => mod(x) === x });",
  "export const q = forall(id, { ensures: (x) => id(x) === x });",
  "export const r = forall(first, { ensures: (xs) => first(xs) === first(xs) });",
  "export const s = forall(orZero, { ensures: (x) => orZero(x) === orZero(x) });",
].join("\n");

const noLists: EngineRestriction = {
  takes: (t) => t.kind !== "list" && t.kind !== "nothing",
  reason: "no arrays here",
  bodies: listKinds,
};
const noNulls: EngineRestriction = {
  takes: (t) => t.kind !== "nullable" && t.kind !== "null" && t.kind !== "union",
  reason: "no nullable types here",
};

describe("readForEngine", () => {
  test("with no restriction: every function with specs, and what the reader could not read outside with its construct and line", () => {
    const got = readForEngine({ source, specs: read(source, spec) }, []);
    expect(got.fns.map((f) => f.name)).toEqual(["mod", "id", "first", "orZero"]);
    expect([...got.outside]).toEqual([
      ["mod", "outside the engine's subset (line 2): the % operator"],
    ]);
    expect(got.module.functions.map((f) => f.name).sort()).toEqual(["first", "id", "orZero"]);
  });

  test("each restriction puts what it refuses outside with its own reason, in order", () => {
    const got = readForEngine({ source, specs: read(source, spec) }, [noLists, noNulls]);
    expect(got.outside.get("first")).toContain("no arrays here");
    expect(got.outside.get("orZero")).toContain("no nullable types here");
    expect(got.outside.has("id")).toBe(false);
    expect(got.module.functions.map((f) => f.name)).toEqual(["id"]);
  });

  test("a function two restrictions refuse keeps the reason of the one applied first", () => {
    const both =
      "export function pick(xs: readonly number[], x: number | null): number { return x === null ? xs.length : x; }";
    const specs = read(
      both,
      'import { forall } from "eutaxy/spec";\nimport { pick } from "./domain.ts";\nexport const p = forall(pick, { ensures: (xs, x) => pick(xs, x) === pick(xs, x) });',
    );
    const listsFirst = readForEngine({ source: both, specs }, [noLists, noNulls]);
    expect(listsFirst.outside.get("pick")).toContain("no arrays here");
    const nullsFirst = readForEngine({ source: both, specs }, [noNulls, noLists]);
    expect(nullsFirst.outside.get("pick")).toContain("no nullable types here");
  });

  test("a restriction may refuse a body for what it computes, whatever its types", () => {
    const noSums: EngineRestriction = {
      takes: () => true,
      reason: "no sums here",
      bodies: new Set(),
      refused: (body) => body.kind === "binary" && body.op === "+",
    };
    const sums =
      "export function inc(x: number): number { return x + 1; }\nexport function id(x: number): number { return x; }";
    const specs = read(
      sums,
      'import { forall } from "eutaxy/spec";\nimport { id, inc } from "./domain.ts";\nexport const p = forall(inc, { ensures: (x) => inc(x) === inc(x) });\nexport const q = forall(id, { ensures: (x) => id(x) === x });',
    );
    const got = readForEngine({ source: sums, specs }, [noSums]);
    expect(got.outside.get("inc")).toContain("no sums here");
    expect(got.outside.has("id")).toBe(false);
  });

  test("only the functions asked for are reported on", () => {
    const got = readForEngine({ source, specs: read(source, spec), functions: ["id", "mod"] }, []);
    expect(got.fns.map((f) => f.name)).toEqual(["mod", "id"]);
    expect([...got.outside.keys()]).toEqual(["mod"]);
  });

  test("a spec that names a declaration which is not the module's top-level one of that name is outside", () => {
    const nested =
      "export namespace inner {\n  export function id(x: number): number { return x + 1; }\n}\nexport function id(x: number): number { return x; }";
    const specs = read(
      nested,
      'import { forall } from "eutaxy/spec";\nimport { id } from "./domain.ts";\nexport const q = forall(id, { ensures: (x) => id(x) === x });',
    );
    // The spec as the reader found it, moved onto the nested declaration.
    const moved = {
      ...specs,
      functions: specs.functions.map((f) => ({ ...f, offset: f.offset - 1, line: 2 })),
    };
    const got = readForEngine({ source: nested, specs: moved }, []);
    expect(got.outside.get("id")).toBe(
      "outside the engine's subset (line 2): the id the spec names is not the module's top-level declaration of that name (line 4)",
    );
  });
});

describe("what an engine reports for a module it read", () => {
  test("the functions outside are unsupported, each property with its function's reason", () => {
    const got = readForEngine({ source, specs: read(source, spec) }, [noLists]);
    expect(outsideProofs(got.fns, got.outside)).toEqual([
      {
        function: "mod",
        property: "p",
        outcome: unknownOutcome(
          "unsupported",
          "outside the engine's subset (line 2): the % operator",
        ),
      },
      {
        function: "first",
        property: "r",
        outcome: unknownOutcome("unsupported", got.outside.get("first") as string),
      },
    ]);
  });

  test("an emitter's refusal puts every function outside with that reason", () => {
    const got = readForEngine({ source, specs: read(source, spec) }, []);
    engineGap(got, "a construct the emitter does not know");
    expect([...new Set(got.outside.values())]).toEqual([
      "outside the engine's subset: a construct the emitter does not know",
    ]);
    expect(outsideProofs(got.fns, got.outside)).toHaveLength(4);
  });

  test("proofsOf gives every property the one outcome, or its function's", () => {
    const got = readForEngine({ source, specs: read(source, spec), functions: ["id", "mod"] }, []);
    const gaveUp = unknownOutcome("gave_up", "out of time");
    expect(proofsOf(got.fns, gaveUp).map((p) => `${p.function}.${p.property}`)).toEqual([
      "mod.p",
      "id.q",
    ]);
    expect(
      proofsOf(got.fns, (f) => unknownOutcome("unavailable", f.name)).map((p) => p.outcome),
    ).toEqual([unknownOutcome("unavailable", "mod"), unknownOutcome("unavailable", "id")]);
  });
});
