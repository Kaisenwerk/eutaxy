import { describe, expect, test } from "vitest";
import { extractSpecs } from "./extract.ts";

const module = `
import type { Wallet } from "./types.ts";

/** Not a spec, just a comment. */
export const limit = 100, floor = 0;
export { helper, internal as renamed };
export type { Wallet };
export interface Shape { readonly n: number }
const helper = (x: number) => x;
const internal = 1;

/**
 * Whether a withdrawal may go ahead.
 *
 * @ensures{never-negative} forall (balance amount: int) {
 *   balance >= 0 ∧ amount > 0 ==> decide(balance, amount).balance >= 0
 * }
 * @ensures{rejects-overdraft} forall (balance amount: int) {
 *   amount > balance ==> ¬decide(balance, amount).ok
 * }
 * @total
 * @param balance the balance now, as an email like "a@b.c" would not start a tag
 */
export function decide(balance: number, amount: number): { ok: boolean; balance: number } {
  return amount > balance ? { ok: false, balance } : { ok: true, balance: balance - amount };
}

/** @throws */
export async function* gen<T extends Map<string, number>>(this: void, { a }: T, ...rest: number[]): AsyncGenerator<number> {}
`;

describe("extractSpecs", () => {
  const specs = extractSpecs(module);

  test("finds each annotated function with its properties and markers", () => {
    expect(specs.errors).toEqual([]);
    const [decide, gen] = specs.functions;
    expect(decide?.name).toBe("decide");
    expect(decide?.params).toEqual(["balance", "amount"]);
    expect(decide?.ensures.map((e) => e.name)).toEqual(["never-negative", "rejects-overdraft"]);
    expect(decide?.ensures[1]?.property.requires).toEqual([
      { kind: "atom", text: "amount > balance" },
    ]);
    expect(decide?.total).toBe(true);
    expect(decide?.throws).toBe(false);
    expect(decide?.line).toBe(24);
    expect(gen?.name).toBe("gen");
    expect(gen?.params).toEqual([null, null]);
    expect(gen?.throws).toBe(true);
  });

  test("type arguments in annotations do not split parameters", () => {
    const f = extractSpecs(
      "/** @total */\nexport function f(x = (1 > 0), y: Map<string, number[]>, z = (2 >> 1), w?: Array<Array<number>>) {}",
    ).functions[0];
    expect(f?.params).toEqual(["x", "y", "z", "w"]);
  });

  test("a default value with a top-level < or > is ambiguous, and an error rather than a guess", () => {
    for (const header of ["f(x = pair<A, B>(), y: number)", "f(x = 1 > 0, y: number)"]) {
      const specs = extractSpecs(
        `/** @ensures{p} forall (y: int) { y > 0 } */\nexport function ${header} {}`,
      );
      expect(specs.errors.map((e) => e.message)).toEqual([
        "cannot tell the parameters of f apart: a default value has a top-level < or >; parenthesize it",
      ]);
    }
  });

  test("annotations on two declarations of one function (overloads) are an error", () => {
    const specs = extractSpecs(`
/** @ensures{p} forall (x: int) { x > 0 } */
export function f(x: number): number;
/** @ensures{p} forall (x: string) { x.length > 0 } */
export function f(x: string): string;
export function f(x: number | string) { return x; }
`);
    expect(specs.errors.map((e) => e.message)).toEqual([
      "f is annotated on more than one declaration (overloads): put its annotations on one",
    ]);
    expect(specs.functions.map((f) => f.name)).toEqual(["f"]);
  });

  test("lists exported values, not types or re-exports", () => {
    expect([...specs.exports].sort()).toEqual(
      ["decide", "floor", "gen", "helper", "limit", "renamed"].sort(),
    );
  });

  test("reports annotations that do not parse or do not attach, with their lines", () => {
    const bad = extractSpecs(`
/** @ensures{a} forall (x: float) { x === x } */
export function f(x: number) { return x; }

/** @ensures forall (x: int) { x === x } */
export function g(x: number) { return x; }

/** @ensures{loose} forall (x: int) { x === x } */
const h = (x: number) => x;
`);
    expect(bad.errors.map((e) => [e.line, e.message.split(":")[0]])).toEqual([
      [2, "@ensures{a} on f"],
      [5, "@ensures needs a name, as in @ensures{non-negative}"],
      [8, "Lemma annotations attach to an exported function declaration"],
    ]);
    expect(bad.functions.map((f) => [f.name, f.ensures.length])).toEqual([
      ["f", 0],
      ["g", 0],
    ]);
  });
});
