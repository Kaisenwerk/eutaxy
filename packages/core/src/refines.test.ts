/** `refines`: effects follow the core's decisions, made on state that was still current. */
import { describe, expect, test } from "vitest";
import type { JsonValue } from "./canonical-json.ts";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import { checkInvariant, decisionTarget, type Refines } from "./invariants.ts";

/** A refund: read the order's refunded total, decide, write the new total. */
type Step =
  | readonly ["read", string, number]
  | readonly ["decide", string, number, boolean]
  | readonly ["write", string, number, number?];

function log(steps: readonly Step[]): EffectLog {
  let l = emptyLog;
  const add = (invocation: string, target: string, op: string, payload: JsonValue) => {
    l = appendEffect(l, { kind: "result", invocation, target, op, payload });
  };
  for (const s of steps) {
    if (s[0] === "read")
      add(s[1], "D1:DB", "first", {
        args: { sql: "SELECT", params: ["o-1"] },
        result: { row: { refunded: s[2] } },
      });
    else if (s[0] === "decide")
      add(s[1], decisionTarget("decideRefund"), "decide", {
        args: [1000, s[2], 400],
        result: { ok: s[3], refunded: s[2] + 400 },
      });
    else
      add(s[1], "D1:DB", "run", {
        args: { sql: "UPDATE", params: ["o-1", s[2]] },
        result: { changes: s[3] ?? 1 },
      });
  }
  return l;
}

const refines: Refines = {
  kind: "refines",
  name: "refund-follows-decision",
  decision: "decideRefund",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  follows: [{ effect: "args.params.1", decision: "result.refunded" }],
  state: {
    read: { target: "D1:DB", op: "first", kind: "result" },
    write: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
    key: "args.params.0",
  },
};

describe("refines", () => {
  test("holds when each write follows a decision made on current state", () => {
    expect(
      checkInvariant(
        log([
          ["read", "a", 0],
          ["decide", "a", 0, true],
          ["write", "a", 400],
          ["read", "b", 400],
          ["decide", "b", 400, true],
          ["write", "b", 800],
        ]),
        refines,
      ),
    ).toBeNull();
  });

  test("a lost update: the second write rests on a read the first had already changed", () => {
    const v = checkInvariant(
      log([
        ["read", "a", 0],
        ["read", "b", 0],
        ["decide", "a", 0, true],
        ["decide", "b", 0, true],
        ["write", "a", 400],
        ["write", "b", 400],
      ]),
      refines,
    );
    expect(v?.keys).toEqual(["stale_read", '"o-1"']);
    expect(v?.evidence).toEqual([1, 3, 4, 5]);
    expect(v?.message).toContain("a changed it");
  });

  test("a write that changed nothing is not an effect: a compare-and-set that lost is fine", () => {
    expect(
      checkInvariant(
        log([
          ["read", "a", 0],
          ["read", "b", 0],
          ["decide", "a", 0, true],
          ["decide", "b", 0, true],
          ["write", "a", 400],
          ["write", "b", 400, 0],
        ]),
        refines,
      ),
    ).toBeNull();
  });

  test("an effect with no decision before it in its invocation", () => {
    const v = checkInvariant(
      log([
        ["decide", "a", 0, true],
        ["write", "b", 400],
      ]),
      refines,
    );
    expect(v?.keys).toEqual(["no_decision"]);
  });

  test("with state, a decision must rest on a read of it", () => {
    const v = checkInvariant(
      log([
        ["decide", "a", 0, true],
        ["write", "a", 400],
      ]),
      refines,
    );
    expect(v?.keys).toEqual(["no_read"]);
  });

  test("a core call that threw is not a decision", () => {
    let l = emptyLog;
    l = appendEffect(l, {
      kind: "result",
      invocation: "a",
      target: decisionTarget("decideRefund"),
      op: "decide",
      payload: { args: [1000, 0, 400], error: "Error: boom" },
    });
    l = appendEffect(l, {
      kind: "result",
      invocation: "a",
      target: "D1:DB",
      op: "run",
      payload: { args: { sql: "UPDATE", params: ["o-1", 400] }, result: { changes: 1 } },
    });
    expect(checkInvariant(l, { ...refines, follows: [] })?.keys).toEqual(["no_decision"]);
  });

  test("an effect that disagrees with its decision", () => {
    const v = checkInvariant(
      log([
        ["read", "a", 0],
        ["decide", "a", 0, true],
        ["write", "a", 500],
      ]),
      refines,
    );
    expect(v?.keys).toEqual(["not_followed", "args.params.1"]);
    expect(v?.message).toContain("args.params.1 is 500 but the decision's result.refunded is 400");
  });

  test("the latest decision counts, and writes to other keys do not make it stale", () => {
    let l = log([
      ["read", "a", 0],
      ["decide", "a", 0, false],
      ["read", "a", 0],
      ["decide", "a", 0, true],
    ]);
    // b carries out its own decision, on another order it read.
    l = appendEffect(l, {
      kind: "result",
      invocation: "b",
      target: "D1:DB",
      op: "first",
      payload: { args: { sql: "SELECT", params: ["o-2"] }, result: { row: { refunded: 0 } } },
    });
    l = appendEffect(l, {
      kind: "result",
      invocation: "b",
      target: decisionTarget("decideRefund"),
      op: "decide",
      payload: { args: [1000, 0, 1], result: { ok: true, refunded: 1 } },
    });
    l = appendEffect(l, {
      kind: "result",
      invocation: "b",
      target: "D1:DB",
      op: "run",
      payload: { args: { sql: "UPDATE", params: ["o-2", 1] }, result: { changes: 1 } },
    });
    l = appendEffect(l, {
      kind: "result",
      invocation: "a",
      target: "D1:DB",
      op: "run",
      payload: { args: { sql: "UPDATE", params: ["o-1", 400] }, result: { changes: 1 } },
    });
    expect(checkInvariant(l, refines)).toBeNull();
  });
});
