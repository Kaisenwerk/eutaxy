import { describe, expect, test } from "vitest";
import { hintsOf, readSpecs } from "./specs.ts";

const module = `
export interface RefundDecision {
  readonly ok: boolean;
  readonly refunded: number;
}
export type Status = "invited" | "active" | "disabled";
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
export const decideAccess = (status: Status | null): "send_code" | "waitlist" =>
  status === "invited" || status === "active" ? "send_code" : "waitlist";
export function judge(attempts: number, matches: boolean): Result<true, { readonly type: "locked" }> {
  return matches ? { ok: true, value: true } : { ok: false, error: { type: "locked" } };
}
function hidden(x: number): number { return x; }
export { hidden as shown };
`;

const read = (spec: string) =>
  readSpecs({ module, spec, moduleSpecifiers: ["./domain.ts", "./domain"] });

describe("readSpecs", () => {
  test("forall over a function declaration: binders are its typed parameters, named as ensures names them", () => {
    const specs = read(`
import { forall, total } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";

export const withinCaptured = forall(decideRefund, {
  when: (c, r) => 0 <= r && r <= c,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
export const decideRefundTotal = total(decideRefund);
`);
    expect(specs.errors).toEqual([]);
    const fn = specs.functions[0];
    expect(fn?.name).toBe("decideRefund");
    expect(fn?.params).toEqual([
      { name: "captured", type: { kind: "number" } },
      { name: "refunded", type: { kind: "number" } },
      { name: "amount", type: { kind: "number" } },
    ]);
    expect(fn?.properties.map((p) => [p.name, p.kind])).toEqual([
      ["withinCaptured", "forall"],
      ["decideRefundTotal", "total"],
    ]);
    const p = fn?.properties[0];
    expect(p?.binders.map((b) => b.name)).toEqual(["captured", "refunded", "amount"]);
    expect(p?.binders[1]?.hint).toEqual({ lower: { value: "0", inclusive: true } });
    expect(p?.binders[0]?.hint).toBeUndefined();
    expect(p?.when).toEqual({
      params: ["c", "r"],
      body: "0 <= r && r <= c",
      block: false,
      line: 6,
    });
    expect(p?.ensures?.params).toEqual(["captured", "refunded", "amount"]);
    expect(p?.ensures?.body).toBe("decideRefund(captured, refunded, amount).refunded <= captured");
    expect(p?.text).toBe("decideRefund(captured, refunded, amount).refunded <= captured");
    expect(p?.line).toBe(5);
    expect(fn?.properties[1]?.text).toBe("total(decideRefund)");
  });

  test("a const arrow, a nullable alias of literals, a generic alias instantiated, a renamed export", () => {
    const specs = read(`
import * as spec from "eutaxy/spec";
import * as domain from "./domain";
export const sendCode = spec.forall(domain.decideAccess, { ensures: (s) => domain.decideAccess(s) !== "" });
export const locks = spec.forall(domain.judge, { ensures: (a, m) => domain.judge(a, m).ok === m });
export const shownIs = spec.forall(domain.shown, { ensures: (x) => domain.shown(x) === x });
`);
    expect(specs.errors).toEqual([]);
    const byName = Object.fromEntries(specs.functions.map((f) => [f.name, f]));
    expect(byName["decideAccess"]?.params[0]?.type).toEqual({
      kind: "union",
      members: [
        { kind: "literal", value: "invited" },
        { kind: "literal", value: "active" },
        { kind: "literal", value: "disabled" },
        { kind: "null" },
      ],
    });
    expect(byName["judge"]?.params.map((p) => p.type)).toEqual([
      { kind: "number" },
      { kind: "boolean" },
    ]);
    expect(byName["shown"]?.params).toEqual([{ name: "x", type: { kind: "number" } }]);
  });

  test("a block body is kept as its statements; a binder without a name in ensures keeps the parameter's", () => {
    const specs = read(`
import { forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";
export const p = forall(decideRefund, {
  ensures: (c) => {
    const d = decideRefund(c, 0, 1);
    return d.refunded <= c;
  },
});
`);
    expect(specs.errors).toEqual([]);
    const p = specs.functions[0]?.properties[0];
    expect(p?.ensures?.block).toBe(true);
    expect(p?.ensures?.body).toContain("const d = decideRefund(c, 0, 1);");
    expect(p?.binders.map((b) => b.name)).toEqual(["c", "refunded", "amount"]);
  });

  test("what does not read is an error with a line, never a guess", () => {
    const specs = read(`
import { forall, total } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";
import { other } from "./other.ts";
const notExported = forall(decideRefund, { ensures: () => true });
export const wrongModule = forall(other, { ensures: () => true });
export const notImported = forall(nope, { ensures: () => true });
export const noEnsures = forall(decideRefund, { when: () => true });
export const notArrow = forall(decideRefund, { ensures: function () { return true; } });
export const extraKey = forall(decideRefund, { ensures: () => true, extra: 1 });
export const unknownFn = total(missing);
export let mutable = total(decideRefund);
`);
    expect(specs.functions).toEqual([]);
    expect(specs.errors.map((e) => [e.line, e.message.split(":")[0]])).toEqual([
      [5, "notExported"],
      [6, "wrongModule"],
      [7, "notImported"],
      [8, "noEnsures"],
      [9, "notArrow"],
      [10, "extraKey"],
      [11, "unknownFn"],
      [12, "mutable"],
    ]);
    expect(specs.errors[0]?.message).toContain("not exported");
    expect(specs.errors[1]?.message).toContain('imported from "./other.ts"');
    expect(specs.errors[2]?.message).toContain("not imported from the module");
    expect(specs.errors[3]?.message).toContain("needs an ensures");
    expect(specs.errors[4]?.message).toContain("must be an arrow function");
    expect(specs.errors[5]?.message).toContain("found extra");
    expect(specs.errors[6]?.message).toContain("not imported");
    expect(specs.errors[7]?.message).toContain("const export");
  });

  test("a spec on a function the module does not export as a readable declaration is an error", () => {
    const specs = read(`
import { forall } from "eutaxy/spec";
import { constant } from "./domain.ts";
export const p = forall(constant, { ensures: () => true });
`);
    expect(specs.errors[0]?.message).toContain("exports no function constant");
  });

  test("forall and total must come from eutaxy/spec; a local forall is not one", () => {
    const specs = read(`
import { decideRefund } from "./domain.ts";
const forall = (f: unknown, p: unknown) => ({ f, p });
export const p = forall(decideRefund, { ensures: () => true });
`);
    expect(specs.functions).toEqual([]);
    expect(specs.errors).toEqual([]);
  });

  test("an optional parameter admits undefined; a rest or destructured one has no name", () => {
    const specs = readSpecs({
      module:
        "export function f(a?: number, { b }: { b: string }, ...rest: number[]): number { return 1; }",
      spec: 'import { forall } from "eutaxy/spec";\nimport { f } from "./m.ts";\nexport const p = forall(f, { ensures: () => true });',
      moduleSpecifiers: ["./m.ts"],
    });
    expect(specs.functions[0]?.params).toEqual([
      { name: "a", type: { kind: "union", members: [{ kind: "number" }, { kind: "undefined" }] } },
      { name: null, type: { kind: "record", fields: [{ name: "b", type: { kind: "string" } }] } },
      { name: null, type: { kind: "unknown", text: "...rest" } },
    ]);
    expect(specs.functions[0]?.properties[0]?.binders.map((b) => b.name)).toEqual([
      "a",
      "arg1",
      "arg2",
    ]);
  });
});

describe("hintsOf", () => {
  const arrow = (params: string[], body: string) => ({ params, body, block: false, line: 1 });

  test("conjuncts about one parameter: integer, bounds on either side, a whole-string regex", () => {
    const hints = hintsOf(
      arrow(
        ["n", "s", "m"],
        "Number.isInteger(n) && 0 <= n && (n < 1_000) && /^[a-z]+$/.test(s) && 5 > m && m >= -2.5",
      ),
    );
    expect(hints.get(0)).toEqual({
      integer: true,
      lower: { value: "0", inclusive: true },
      upper: { value: "1000", inclusive: false },
    });
    expect(hints.get(1)).toEqual({ regex: { pattern: "^[a-z]+$", flags: "" } });
    expect(hints.get(2)).toEqual({
      upper: { value: "5", inclusive: false },
      lower: { value: "-2.5", inclusive: true },
    });
  });

  test("what is not about one parameter alone gives no hint", () => {
    const hints = hintsOf(arrow(["a", "b"], "a <= b && (a > 0 || b > 0) && f(a) < 3"));
    expect(hints.size).toBe(0);
  });

  test("a block body gives no hints", () => {
    expect(hintsOf({ params: ["n"], body: "return n > 0;", block: true, line: 1 }).size).toBe(0);
  });
});

describe("review findings", () => {
  test("a module without semicolons: the first function after an import or an alias is still read", () => {
    for (const module of [
      'import { x } from "./y.ts"\nexport function f(n: number): number { return n }',
      "type T = number\nexport function f(n: T): number { return n }",
      "const k = 1\nexport function f(n: number): number { return n + k }",
    ]) {
      const specs = readSpecs({
        module,
        spec: 'import { forall } from "eutaxy/spec";\nimport { f } from "./m.ts";\nexport const p = forall(f, { ensures: (n) => f(n) === n });',
        moduleSpecifiers: ["./m.ts"],
      });
      expect(specs.errors, module).toEqual([]);
      expect(specs.functions.map((fn) => fn.name)).toEqual(["f"]);
    }
  });

  test("a property carries the spec file's names for the module's functions, aliases and renamed exports resolved", () => {
    const specs = read(`
import { forall } from "eutaxy/spec";
import { decideRefund as decide, shown } from "./domain.ts";
import { other } from "./other.ts";
export const p = forall(decide, { ensures: (c, r, a) => decide(c, r, a).ok || shown(c) === c });
`);
    expect(specs.errors).toEqual([]);
    expect(specs.functions[0]?.properties[0]?.imports).toEqual([
      { local: "decide", fn: "decideRefund" },
      { local: "shown", fn: "hidden" },
    ]);
  });
});

describe("review findings, second round", () => {
  test("a spec export with a type annotation is read, not skipped", () => {
    const specs = read(`
import { type Forall, forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";
export const typed: Forall<typeof decideRefund> = forall(decideRefund, { ensures: () => false });
`);
    expect(specs.errors).toEqual([]);
    expect(specs.functions[0]?.properties.map((p) => p.name)).toEqual(["typed"]);
  });
});
