import { describe, expect, test } from "vitest";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import {
  type AtLeastOnce,
  type AtMostOncePerKey,
  checkInvariant,
  checkInvariants,
  recomputePerMessageExpected,
  sameViolation,
} from "./invariants.ts";
import { getPath, selectEffects } from "./selectors.ts";

/** A D1 insert result as the Cloudflare proxies will record it. */
function insertResult(
  log: EffectLog,
  invocation: string,
  orderId: string,
  changes: number,
): EffectLog {
  return appendEffect(log, {
    kind: "result",
    invocation,
    target: "D1:DB",
    op: "run",
    payload: {
      args: {
        sql: "INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2)",
        params: [orderId, 100],
      },
      result: { changes },
    },
  });
}

const recordedOnce: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "payment-recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};

const everyPayment: AtLeastOnce = {
  kind: "atLeastOnce",
  name: "every-payment-recorded",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
  expected: ["o-1", "o-2"],
};

describe("getPath", () => {
  test("walks objects and arrays by dot path", () => {
    const v = { args: { params: ["o-1", 100] }, result: { changes: 1 } };
    expect(getPath(v, "args.params.0")).toBe("o-1");
    expect(getPath(v, "result.changes")).toBe(1);
    expect(getPath(v, "")).toEqual(v);
    expect(getPath(v, "args.params.5")).toBeUndefined();
    expect(getPath(v, "args.nope.x")).toBeUndefined();
    expect(getPath(v, "args.params.-1")).toBeUndefined();
  });
});

describe("atMostOncePerKey", () => {
  test("passes when each key is written once", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = insertResult(log, "msg-2", "o-2", 1);
    expect(checkInvariant(log, recordedOnce)).toBeNull();
  });

  test("catches the duplicate write after redelivery, with evidence", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = appendEffect(log, {
      kind: "fault",
      invocation: "msg-1",
      target: "Queue:payments",
      op: "ack",
      payload: { fault: "crash_before" },
    });
    log = insertResult(log, "msg-1#2", "o-1", 1); // redelivery
    const v = checkInvariant(log, recordedOnce);
    expect(v).not.toBeNull();
    expect(v?.invariant).toBe("payment-recorded-once");
    expect(v?.evidence).toEqual([0, 2]);
    expect(v?.keys).toEqual(['"o-1"']);
    expect(v?.message).toContain('"o-1"');
  });

  test("ignores a second insert that changed nothing (the idempotent fix)", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = insertResult(log, "msg-1#2", "o-1", 0);
    expect(checkInvariant(log, recordedOnce)).toBeNull();
  });

  test("ignores effects on other targets, ops and kinds", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = appendEffect(log, {
      kind: "call",
      invocation: "msg-1#2",
      target: "D1:DB",
      op: "run",
      payload: { args: { params: ["o-1"] } },
    });
    log = appendEffect(log, {
      kind: "result",
      invocation: "x",
      target: "D1:OTHER",
      op: "run",
      payload: { args: { params: ["o-1"] }, result: { changes: 1 } },
    });
    log = appendEffect(log, {
      kind: "result",
      invocation: "x",
      target: "D1:DB",
      op: "batch",
      payload: { args: { params: ["o-1"] }, result: { changes: 1 } },
    });
    expect(checkInvariant(log, recordedOnce)).toBeNull();
  });
});

describe("selectors", () => {
  test("atLeast matches numeric lower bounds, including multi-row writes", () => {
    let log = insertResult(emptyLog, "a", "o-1", 3);
    log = insertResult(log, "b", "o-1", 0);
    log = appendEffect(log, {
      kind: "result",
      invocation: "c",
      target: "D1:DB",
      op: "run",
      payload: { args: { params: ["o-1"] }, result: { changes: "1" } },
    });
    expect(selectEffects(log, recordedOnce.effect).map((e) => e.seq)).toEqual([0]);
  });

  test("keys with the same JSON value compare equal regardless of key order", () => {
    const inv: AtMostOncePerKey = { ...recordedOnce, key: "args.params.0" };
    let log = appendEffect(emptyLog, {
      kind: "result",
      invocation: "a",
      target: "D1:DB",
      op: "run",
      payload: { args: { params: [{ a: 1, b: 2 }] }, result: { changes: 1 } },
    });
    log = appendEffect(log, {
      kind: "result",
      invocation: "b",
      target: "D1:DB",
      op: "run",
      payload: { args: { params: [{ b: 2, a: 1 }] }, result: { changes: 1 } },
    });
    expect(checkInvariant(log, inv)?.evidence).toEqual([0, 1]);
    const want: AtLeastOnce = { ...everyPayment, expected: [{ b: 2, a: 1 }] };
    expect(checkInvariant(log, want)).toBeNull();
  });
});

describe("atLeastOnce", () => {
  test("passes when every expected key was written", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = insertResult(log, "msg-2", "o-2", 1);
    expect(checkInvariant(log, everyPayment)).toBeNull();
  });

  test("reports the keys that never made it", () => {
    const log = insertResult(emptyLog, "msg-1", "o-1", 1);
    const v = checkInvariant(log, everyPayment);
    expect(v?.message).toContain('"o-2"');
    expect(v?.message).not.toContain('"o-1"');
    expect(v?.keys).toEqual(['"o-2"']);
    expect(v?.evidence).toEqual([0]);
  });
});

describe("sameViolation and recomputePerMessageExpected", () => {
  test("compares invariant and keys only", () => {
    const a = { invariant: "x", message: "m1", keys: ['"k"'], evidence: [0, 1] };
    const b = { invariant: "x", message: "m2", keys: ['"k"'], evidence: [5, 9] };
    const c = { invariant: "x", message: "m2", keys: ['"j"'], evidence: [5, 9] };
    expect(sameViolation(a, b)).toBe(true);
    expect(sameViolation(a, c)).toBe(false);
    expect(sameViolation(a, { ...b, invariant: "y" })).toBe(false);
  });

  test("re-derives per-message expectations and leaves others alone", () => {
    const perMessage: AtLeastOnce = { ...everyPayment, perMessage: { bodyKey: "orderId" } };
    const out = recomputePerMessageExpected(
      [perMessage, recordedOnce, everyPayment],
      [{ orderId: "o-9" }, { x: 1 }],
    );
    expect((out[0] as AtLeastOnce).expected).toEqual(["o-9"]);
    expect(out[1]).toBe(recordedOnce);
    expect((out[2] as AtLeastOnce).expected).toEqual(["o-1", "o-2"]);
  });
});

describe("checkInvariants", () => {
  test("returns one violation per failing invariant, in order", () => {
    let log = insertResult(emptyLog, "msg-1", "o-1", 1);
    log = insertResult(log, "msg-1#2", "o-1", 1);
    const vs = checkInvariants(log, [recordedOnce, everyPayment]);
    expect(vs.map((v) => v.invariant)).toEqual(["payment-recorded-once", "every-payment-recorded"]);
  });
});
