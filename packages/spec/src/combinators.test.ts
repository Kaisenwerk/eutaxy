import { describe, expect, test } from "vitest";
import { forall, isSpec, total } from "./combinators.ts";

const f = (a: number, b: string): boolean => a > b.length;

describe("forall and total", () => {
  test("are plain data holding the function, with the precondition only when given", () => {
    const p = forall(f, { ensures: (a, b) => f(a, b) === a > b.length });
    expect(p.kind).toBe("forall");
    expect(p.fn).toBe(f);
    expect("when" in p).toBe(false);
    const q = forall(f, { when: (a) => a > 0, ensures: () => true });
    expect(q.when?.(1, "")).toBe(true);
    expect(total(f)).toEqual({ kind: "total", fn: f });
  });

  test("isSpec tells the two shapes from anything else a spec file may export", () => {
    expect(isSpec(forall(f, { ensures: () => true }))).toBe(true);
    expect(isSpec(total(f))).toBe(true);
    expect(isSpec({ kind: "forall", fn: f })).toBe(false);
    expect(isSpec({ kind: "total" })).toBe(false);
    expect(isSpec(f)).toBe(false);
    expect(isSpec(null)).toBe(false);
  });
});
