/**
 * Runs inside workerd: a step attempt that outlives its timeout runs on as
 * the late attempt while the step is retried and, when the step fails for
 * good, recovered from. The timeout is placed as a fault at the attempt's
 * start and measured when the object the attempt calls naps past it; in a
 * concurrent run the late attempt's call lands before or after the retry's
 * and the recovery's. The object's fence holds: an abandoned turn never has
 * a run.
 *
 * The checks, for a start that answers at once and one that naps past the
 * timeout: every schedule with one fault at one invocation in flight is
 * BOUNDED, exhaustively, and so are 50 seeded runs of two in flight with up
 * to two faults a run (runs with two faults at one in flight are not
 * explored here). The replays pin the late attempt, the order it lands in,
 * and the recovery.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform } from "@eutaxy/cloudflare";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { replay } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { told } from "../told.ts";
import { untimed } from "../untimed.ts";
import { turn } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });

const ops = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

const turns = (log: EffectLog) =>
  (lastSnapshot(log as never, "DO:CHAT")?.["c/turns"] ?? []) as {
    id: string;
    fenced: number;
    run_id: string | null;
  }[];

const W = "workflow:TURNS:t-1#1";

/** The first attempt outlives its timeout from its start. */
const lateAtStart = {
  invocation: W,
  ordinal: 0,
  fault: "ambiguous" as const,
  target: "Workflow:TURNS",
  op: "step",
};

async function replayed(napMs: number, concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(turn(napMs, concurrency, 2), platform(), schedule);
  return { log, lines: ops(log), turns: turns(log) };
}

test.each([0, 180_000])(
  "a start napping %i ms, one invocation in flight: every schedule with one fault holds, exhaustively",
  async (napMs) => {
    const verdict = await check(turn(napMs, 1, 1), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      exhaustive: true,
      now: untimed,
      maxRuns: 1_000,
    });
    expect(verdict.kind, told(verdict)).toBe("BOUNDED");
    expect(verdict.reached.exhaustive?.complete).toBe(true);
  },
);

// A sampled run places up to two faults (none in a tenth of the runs, else one or two), so these
// runs cover schedules with none or one too.
test.each([0, 180_000])(
  "a start napping %i ms, two invocations in flight, up to two faults a run, 50 seeded runs: BOUNDED",
  async (napMs) => {
    // A late start's fetch, taken after the flow's confirming read, can take a crash fault: the object
    // is reset by the run's last event, and woken inside the run for the snapshot.
    const verdict = await check(turn(napMs, 2, 2), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      maxRuns: 50,
    });
    expect(verdict.kind, told(verdict)).toBe("BOUNDED");
  },
);

describe("an attempt that outlives its timeout from its start (the fault)", () => {
  test("runs on late while the step is retried: both starts reach the object, the retry's answer is the step's", async () => {
    const { lines, turns } = await replayed(0, 1, { seed: 0, faults: [lateAtStart] });
    expect(lines).toContain(`${W} fault Workflow:TURNS step`);
    expect(lines.filter((l) => l === `${W} result DO:CHAT startTurn`)).toHaveLength(2);
    expect(lines).toContain(`${W} result Workflow:TURNS late_result`);
    expect(lines).toContain(`${W} result Workflow:TURNS complete`);
    expect(turns).toEqual([{ id: "t-1", fenced: 0, run_id: "run-t-1" }]);
  });

  test("in a concurrent run its call lands before or after the retry's start, by the seed, and each order replays", async () => {
    const orders = new Map<string, number>();
    for (let seed = 1; seed <= 12; seed++) {
      const { lines } = await replayed(0, 2, { seed, faults: [lateAtStart] });
      const starts = lines.filter((l) => / (call|result) DO:CHAT startTurn$/.test(l));
      const late = lines.indexOf(`${W} result Workflow:TURNS late_result`);
      // The retry's attempt: the second step point (the first is the late attempt's).
      const retry = lines.indexOf(
        `${W} result Workflow:TURNS step`,
        lines.indexOf(`${W} result Workflow:TURNS step`) + 1,
      );
      expect(starts).toHaveLength(4);
      // The late attempt settled before the retry's attempt started, or time passed over it first.
      orders.set(late < retry ? "late attempt first" : "retry started first", seed);
    }
    expect([...orders.keys()].sort()).toEqual(["late attempt first", "retry started first"]);
    for (const seed of orders.values()) {
      const once = await replayed(0, 2, { seed, faults: [lateAtStart] });
      const twice = await replayed(0, 2, { seed, faults: [lateAtStart] });
      expect(twice.lines).toEqual(once.lines);
    }
  });

  test("when the retry outlives its timeout too, the recovery fences the turn and cancels the run: no run", async () => {
    // A sequential run: the first late start runs to its end (its run is written) before the retry,
    // whose start is late too (its step point is the invocation's fifth: the late attempt's call, its
    // fetch and its result note come first); the step fails for good and the recovery fences the turn.
    const { lines, turns } = await replayed(0, 1, {
      seed: 0,
      faults: [lateAtStart, { ...lateAtStart, ordinal: 4 }],
    });
    expect(lines.filter((l) => l === `${W} fault Workflow:TURNS step`)).toHaveLength(2);
    expect(lines).toContain(`${W} result DO:CHAT abandonTurn`);
    expect(lines.filter((l) => l === `${W} result Workflow:TURNS late_result`)).toHaveLength(2);
    expect(turns).toEqual([{ id: "t-1", fenced: 1, run_id: null }]);
  });
});

describe("a step timeout measured in virtual time", () => {
  test("a start napping past the timeout inside the object is timed out, retried and, failing again, abandoned", async () => {
    const { lines, turns } = await replayed(180_000, 1, { seed: 0, faults: [] });
    expect(lines.filter((l) => l === `${W} result Workflow:TURNS step_timeout`)).toHaveLength(2);
    expect(lines).toContain(`${W} result DO:CHAT abandonTurn`);
    expect(lines.filter((l) => l === `${W} result Workflow:TURNS late_result`)).toHaveLength(2);
    expect(turns).toEqual([{ id: "t-1", fenced: 1, run_id: null }]);
  });
});
