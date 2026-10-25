import { describe, expect, test } from "vitest";
import { appendEffect, digestLog, type EffectLog, emptyLog, serializeLog } from "./effect-log.ts";
import { nextInt, type PrngState, seedPrng } from "./prng.ts";
import { utf8Encode } from "./utf8.ts";

/**
 * A stand-in for a simulated run: a scripted consumer that draws every choice
 * (which op, which invocation, whether a fault lands) from the PRNG and records
 * it as effects. Real runs will come from the engine; the property under test
 * is the same: same seed and inputs, same bytes.
 */
function scriptedRun(seed: number | string, steps: number): EffectLog {
  const ops = ["run", "batch", "send", "ack"] as const;
  const faults = ["crash_before", "crash_after", "ambiguous", "error"] as const;
  let s: PrngState = seedPrng(seed);
  let log = emptyLog;
  for (let i = 0; i < steps; i++) {
    let r: number;
    [r, s] = nextInt(s, ops.length);
    const op = ops[r] ?? "run";
    [r, s] = nextInt(s, 3);
    const invocation = `msg-${r}`;
    log = appendEffect(log, {
      kind: "call",
      invocation,
      target: op === "send" || op === "ack" ? "Queue:JOBS" : "D1:DB",
      op,
      payload: { attempt: i, key: `k${r}` },
    });
    [r, s] = nextInt(s, 5);
    if (r === 0) {
      let f: number;
      [f, s] = nextInt(s, faults.length);
      log = appendEffect(log, {
        kind: "fault",
        invocation,
        target: "D1:DB",
        op,
        payload: { fault: faults[f] ?? "error" },
      });
    } else {
      log = appendEffect(log, {
        kind: "result",
        invocation,
        target: "D1:DB",
        op,
        payload: { ok: true, rows: r },
      });
    }
  }
  return log;
}

describe("effect log", () => {
  test("appendEffect assigns dense sequence numbers and leaves the input unchanged", () => {
    const a = appendEffect(emptyLog, {
      kind: "call",
      invocation: "i",
      target: "D1:DB",
      op: "run",
      payload: null,
    });
    const b = appendEffect(a, {
      kind: "result",
      invocation: "i",
      target: "D1:DB",
      op: "run",
      payload: 1,
    });
    expect(emptyLog.entries).toHaveLength(0);
    expect(a.entries.map((e) => e.seq)).toEqual([0]);
    expect(b.entries.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("the same seed produces a byte-identical serialised log, twice", () => {
    const first = utf8Encode(serializeLog(scriptedRun("seed-A", 500)));
    const second = utf8Encode(serializeLog(scriptedRun("seed-A", 500)));
    expect(first.length).toBeGreaterThan(10_000);
    expect(first).toEqual(second);
    expect(digestLog(scriptedRun("seed-A", 500))).toBe(digestLog(scriptedRun("seed-A", 500)));
  });

  test("a different seed produces a different log", () => {
    expect(serializeLog(scriptedRun("seed-A", 500))).not.toBe(
      serializeLog(scriptedRun("seed-B", 500)),
    );
    expect(digestLog(scriptedRun(1, 50))).not.toBe(digestLog(scriptedRun(2, 50)));
  });

  test("serialisation is one canonical JSON object per line in sequence order", () => {
    const lines = serializeLog(scriptedRun(11, 20)).split("\n");
    expect(lines).toHaveLength(40);
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as { seq: number };
      expect(parsed.seq).toBe(i);
      expect(line).toBe(line.trim());
      expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    });
  });

  test("digest is 16 lowercase hex digits", () => {
    expect(digestLog(emptyLog)).toMatch(/^[0-9a-f]{16}$/);
    expect(digestLog(scriptedRun(1, 5))).toMatch(/^[0-9a-f]{16}$/);
  });
});
