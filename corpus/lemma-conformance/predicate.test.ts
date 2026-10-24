import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PredicateOutcome, parseProperty, predicateSource } from "@eutaxy/spec";
import { afterAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "eutaxy-predicate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** Compile a property's predicate the way a generated module does, and load it. */
async function predicate(text: string): Promise<(...args: unknown[]) => PredicateOutcome> {
  const file = join(dir, `p${n++}.ts`);
  writeFileSync(
    file,
    `const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") throw new TypeError("not a boolean: " + String(v));
  return v;
};
const same = Object.is;
const unresolved = (names: string[]): never => {
  throw new ReferenceError("unresolved: " + names.join(", "));
};
// The module's namespace, as an import of it would give: one of its own, one re-exported.
const ns = { half: (x: number) => x / 2, reExported: (x: number) => x + 1, limit: 5, number: (x: number) => x };
export default ${predicateSource(parseProperty(text), { bool: "bool", same: "same", scope: "ns", unresolved: "unresolved" })};
`,
  );
  return ((await import(file)) as { default: (...args: unknown[]) => PredicateOutcome }).default;
}

describe("predicateSource", () => {
  test("preconditions discard, the claim decides", async () => {
    const p = await predicate("forall (x: int) { x > 0 ==> half(x) < x }");
    expect(p(4)).toBe("held");
    expect(p(-4)).toBe("discarded");
    const q = await predicate("forall (x: int) { x !== 0 ==> half(x) > 0 }");
    expect(q(-2)).toBe("refuted");
  });

  test("connectives are classical, a parenthesized implication material", async () => {
    const p = await predicate("forall (a b: boolean) { (a → b) ↔ ¬a ∨ b }");
    for (const a of [true, false]) for (const b of [true, false]) expect(p(a, b)).toBe("held");
  });

  test("≡ is SameValue: NaN equals NaN, +0 is not -0", async () => {
    expect((await predicate("forall (x: number) { x ≡ x }"))(Number.NaN)).toBe("held");
    expect((await predicate("forall (x: number) { x ≢ -x }"))(0)).toBe("held");
  });

  test("a non-boolean atom is an error, not false", async () => {
    const p = await predicate("forall (x: int) { x + 1 }");
    expect(() => p(1)).toThrow(TypeError);
  });
});

describe("generated names", () => {
  test("a name neither the module nor the globals define is an error, never undefined", async () => {
    await expect(
      predicate("forall (x: int) { missing === undefined }").then((p) => p(1)),
    ).rejects.toThrow("unresolved: missing");
  });

  test("an arrow's parameter is bound only inside it", async () => {
    // Outside the arrow, limit is the module's.
    expect(
      (await predicate("forall (x: int) { [x].every(limit => limit === x) ∧ x < limit }"))(2),
    ).toBe("held");
    expect(
      (await predicate("forall (x: int) { [x].every((limit, i) => limit + i === x) ∧ x < limit }"))(
        2,
      ),
    ).toBe("held");
  });

  test("function expressions and destructuring renames bind their names", async () => {
    expect(
      (await predicate("forall (x: int) { [x].every(function (v) { return v === x; }) }"))(2),
    ).toBe("held");
    expect(
      (await predicate("forall (x: int) { [x].every(function named(v) { return v === x; }) }"))(2),
    ).toBe("held");
    expect(
      (await predicate("forall (x: int) { [{ a: x }].every(({ a: renamed }) => renamed === x) }"))(
        2,
      ),
    ).toBe("held");
    expect(
      (await predicate("forall (x: int) { [[x]].every(([first]: number[]) => first === x) }"))(2),
    ).toBe("held");
  });

  test("names in a parameter's default value are references, not parameters", async () => {
    const p = await predicate(
      'forall (x: int) { ((v = reExported(limit)) => typeof limit === "undefined")(x) }',
    );
    expect(p(2)).toBe("refuted");
  });

  test("a for-of or for-in head binds its names in the loop", async () => {
    expect(
      (
        await predicate(
          "forall (x: int) { [x].every(v => { for (const y of [v]) { if (y !== x) return false; } return true; }) }",
        )
      )(2),
    ).toBe("held");
    expect(
      (
        await predicate(
          'forall (x: int) { [x].every(v => { for (const k in { a: v }) { if (k !== "a") return false; } return true; }) }',
        )
      )(2),
    ).toBe("held");
  });

  test("a catch binding is local to its block", async () => {
    expect(
      (
        await predicate(
          "forall (x: int) { [x].every(v => { try { return v === x; } catch (err) { return false; } }) }",
        )
      )(2),
    ).toBe("held");
  });

  test("a function declaration binds its name in the enclosing block", async () => {
    expect(
      (
        await predicate(
          "forall (x: int) { [x].every(v => { function equal(y) { return y === v; } return equal(x); }) }",
        )
      )(2),
    ).toBe("held");
  });

  test("object methods bind their names and parameters", async () => {
    expect((await predicate("forall (x: int) { ({ ok() { return x > 0; } }).ok() }"))(2)).toBe(
      "held",
    );
    expect(
      (await predicate("forall (x: int) { ({ same(v: number) { return v === x; } }).same(x) }"))(2),
    ).toBe("held");
  });

  test("a template inside an arrow sees the arrow's parameters", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the property itself holds a template literal.
    expect((await predicate("forall (x: int) { [x].every(y => `${y}`.length > 0) }"))(2)).toBe(
      "held",
    );
  });

  test("a value named like a type word is still a value", async () => {
    expect((await predicate("forall (x: int) { number(x) === x ∧ (x as number) === x }"))(2)).toBe(
      "held",
    );
  });

  test("comparisons are not a generic call's type arguments", async () => {
    expect((await predicate("forall (x: int) { Boolean(x < limit && x > (0)) }"))(2)).toBe("held");
  });

  test("a comparison after a type assertion is still a comparison", async () => {
    expect((await predicate("forall (x: int) { (x as number < limit) }"))(2)).toBe("held");
  });

  test("callbacks with return types bind their parameters", async () => {
    expect(
      (await predicate("forall (x: int) { [x].every((v: number): boolean => v === x) }"))(2),
    ).toBe("held");
    expect(
      (
        await predicate(
          "forall (x: int) { [x].every(function (v: number): boolean { return v === x; }) }",
        )
      )(2),
    ).toBe("held");
  });

  test("as and satisfies are type operators, not names", async () => {
    expect(
      (await predicate("forall (x: int) { (x as number) === x ∧ (x satisfies number) === x }"))(2),
    ).toBe("held");
  });

  test("object keys and callback parameters are not free names", async () => {
    expect(
      (
        await predicate(
          "forall (x: int) { [x].every((v) => v === x) ∧ [x].some(w => w === x) ∧ ({ key: x }).key === x }",
        )
      )(2),
    ).toBe("held");
  });

  test("a binder named like a helper does not shadow it", async () => {
    expect((await predicate("forall (bool: int) { bool === bool }"))(3)).toBe("held");
    expect((await predicate("forall (__eutaxyBool: int) { __eutaxyBool ≡ __eutaxyBool }"))(3)).toBe(
      "held",
    );
  });

  test("free names come from the module, re-exports included, else from the globals", async () => {
    expect(
      (await predicate("forall (x: int) { reExported(x) === x + 1 ∧ Number.isInteger(x) }"))(2),
    ).toBe("held");
  });

  test("a binder named like an intrinsic does not break ≡", async () => {
    expect((await predicate("forall (Object: int) { Object ≡ Object }"))(3)).toBe("held");
  });
});
