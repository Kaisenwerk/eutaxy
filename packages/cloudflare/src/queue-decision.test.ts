/**
 * Queue delivery held to the model of the decision rule whose claims are
 * proved (`settled`, queue-decision.props.ts): of a handler's calls to
 * `ack()` and `retry()` on one message exactly those the rule says take
 * effect are recorded as effective, and the message is delivered again
 * exactly when the model says the delivery was not handled. On every list
 * of up to three calls, the handler completing or throwing after them,
 * with no fault and with a crash before and after every decision the
 * delivery records: each of the handler's calls and the platform's own
 * acknowledgement. Exhaustive within those bounds, not sampled, and each
 * expectation is also written out without the rule's functions.
 */
import type { FaultDecision, JsonValue, ScenarioSpec } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform } from "./platform.ts";
import { type Decision, handled, settled, standingAfter, takesEffect } from "./queue-decision.ts";
import { queue } from "./scenario.ts";

/** Every list of exactly `length` calls. */
function callLists(length: number): Decision[][] {
  if (length === 0) return [[]];
  return callLists(length - 1).flatMap((calls) => [
    [...calls, "ack" as const],
    [...calls, "retry" as const],
  ]);
}

/** A crash injected at the first delivery's `ordinal`-th decision, before it is made or after. */
interface Crash {
  readonly ordinal: number;
  readonly fault: "crash_before" | "crash_after";
}

/** One first delivery: what the handler calls, how it ends, and the crash injected into it, if any. */
interface Case {
  readonly calls: readonly Decision[];
  readonly completes: boolean;
  readonly crash: Crash | null;
}

/**
 * The decisions the first delivery records, in order: the handler's calls,
 * then the platform's acknowledgement when the handler completed without
 * a call. Each is one effect point of the invocation, and its only ones.
 */
function points(calls: readonly Decision[], completes: boolean): Decision[] {
  return calls.length === 0 && completes ? ["ack"] : [...calls];
}

const cases: Case[] = [0, 1, 2, 3].flatMap((length) =>
  callLists(length).flatMap((calls) =>
    [true, false].flatMap((completes) => [
      { calls, completes, crash: null },
      ...points(calls, completes).flatMap((_, ordinal) =>
        (["crash_before", "crash_after"] as const).map((fault) => ({
          calls,
          completes,
          crash: { ordinal, fault },
        })),
      ),
    ]),
  ),
);

/**
 * What the model is told of a case: the calls that were made and whether
 * the handler completed with the platform's acknowledgement made. A crash
 * before a call ends the handler with that call not made; one after it,
 * with it made; a crash before the platform's acknowledgement loses it,
 * and one after it does not.
 */
function told(c: Case): { made: readonly Decision[]; completed: boolean } {
  if (c.crash === null) return { made: c.calls, completed: c.completes };
  if (c.calls.length === 0) return { made: [], completed: c.crash.fault === "crash_after" };
  const made = c.calls.slice(0, c.crash.ordinal + (c.crash.fault === "crash_after" ? 1 : 0));
  return { made, completed: false };
}

/** Runs the case; which of the first delivery's calls were recorded effective, and whether a second delivery was made. */
async function deliver(c: Case): Promise<{ effective: boolean[]; again: boolean }> {
  let again = false;
  const platform = createCloudflarePlatform({
    env: {},
    schemas: {},
    maxRetries: 1,
    handler: {
      queue: async (batch) => {
        for (const message of batch.messages) {
          if (message.attempts > 1) {
            again = true;
            continue;
          }
          for (const call of c.calls) {
            if (call === "ack") message.ack();
            else message.retry();
          }
          if (!c.completes) throw new Error("the handler failed");
        }
      },
    },
  });
  const spec: ScenarioSpec = {
    version: 1,
    name: "queue-decision",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: queue("q", [{ body: null }]),
    setup: [],
    externals: [],
    invariants: [],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 1,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };
  const faults: FaultDecision[] =
    c.crash === null
      ? []
      : [
          {
            invocation: "msg-1#1",
            ordinal: c.crash.ordinal,
            fault: c.crash.fault,
            target: "Queue:q",
            op: points(c.calls, c.completes)[c.crash.ordinal] ?? "ack",
          },
        ];
  const run = new Run({ bounds: spec.bounds, chooser: replayChooser({ seed: 1, faults }) });
  const log = await runOnce(spec, platform, run);
  expect(run.unsupportedReasons).toEqual([]);
  // Every injected crash was taken where it was aimed: none of these runs is a run without its fault.
  expect(log.entries.filter((e) => e.kind === "fault")).toHaveLength(faults.length);
  const effective = log.entries
    .filter(
      (e) =>
        e.kind === "result" &&
        e.invocation === "msg-1#1" &&
        e.target === "Queue:q" &&
        (e.op === "ack" || e.op === "retry") &&
        (e.payload as { args: { implicit?: boolean } }).args.implicit !== true,
    )
    .map((e) => (e.payload as { result: { effective: boolean } }).result.effective);
  return { effective, again };
}

const show = (c: Case): JsonValue => ({ ...c, calls: [...c.calls] }) as unknown as JsonValue;

describe("queue delivery refines the proved decision rule", () => {
  test("every list of up to three calls, completed or thrown, under every crash at a decision", async () => {
    // 15 lists ending both ways are 30 cases; a crash either side of each of their 69 decisions, 138 more.
    expect(cases).toHaveLength(168);
    const wrong: JsonValue[] = [];
    for (const c of cases) {
      const { made, completed } = told(c);
      const { effective, again } = await deliver(c);
      const model = {
        effective: made.map((_, i) => takesEffect(standingAfter("none", made.slice(0, i)))),
        again: !handled(settled(made, completed)),
      };
      // The same written out: only the first call takes effect; the first call decides, and with none the ending does.
      const written = {
        effective: made.map((_, i) => i === 0),
        again: made.length === 0 ? !completed : made[0] === "retry",
      };
      expect(model, JSON.stringify(show(c))).toEqual(written);
      if (JSON.stringify({ effective, again }) !== JSON.stringify(model))
        wrong.push({ case: show(c), delivered: { effective, again }, model });
    }
    expect(wrong).toEqual([]);
  });
});
