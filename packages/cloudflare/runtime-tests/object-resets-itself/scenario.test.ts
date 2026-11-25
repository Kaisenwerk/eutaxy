/**
 * Runs inside workerd: an object resets itself with its own `ctx.abort()`.
 * The simulation did not make that reset, so the run is UNSUPPORTED with
 * the reason, whether or not the object is called again; a call that only
 * fails is no reset.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform } from "@eutaxy/cloudflare";
import type { EffectLog, ScenarioSpec } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { replay } from "@eutaxy/engine";
import { expect, test } from "vitest";
import { told } from "../told.ts";
import {
  calledAgain,
  calledLater,
  leftAlone,
  quitsAfterAnswering,
  quitsTwice,
  refusedThenCalled,
} from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });

/** The platform without the Worker module's exports: the object's class is given no base of the simulation's. */
const platformWithoutExports = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    durableObjects: cloudflareTest,
  });

const verdictOf = (s: ScenarioSpec) =>
  check(s, platform(), { seed: "gate", maxRuns: 2, budgetMs: 30_000 });

/** What each call into the counter gave back, in order: its result, or its error. */
const answers = (log: EffectLog): unknown[] =>
  log.entries.flatMap((e) => {
    if (e.kind !== "result" || e.target !== "DO:COUNTER") return [];
    const p = e.payload as { result: unknown; error?: string };
    return [p.error ?? p.result];
  });

const resetItself =
  "Durable Object c reset itself with ctx.abort() during the run; the simulation resets an object only where it injects a crash, so what this one held in memory and had in flight is not modelled";
const reconstructed =
  "Durable Object c was reset during the run and reconstructed for the snapshot; its constructor ran outside the simulation";

/** The verdict's reasons, as the run gave them. */
async function reasons(s: ScenarioSpec): Promise<string[]> {
  const verdict = await verdictOf(s);
  expect(verdict.kind, told(verdict)).toBe("UNSUPPORTED");
  if (verdict.kind !== "UNSUPPORTED") return [];
  expect(verdict.cause).toBe("unsupported_api");
  // The run that reached it is handed back to replay, and replayed alone gets there again.
  expect(verdict.replay, told(verdict)).toBeDefined();
  return verdict.reason
    .split("; Durable Object ")
    .map((r, i) => (i === 0 ? r : `Durable Object ${r}`));
}

test("an object that resets itself and is called by a later request: UNSUPPORTED, the reset named once", async () => {
  // What the runtime does: the call that resets fails with the reason, and the next finds a new
  // instance, whose memory starts over (it answers 1 again).
  const log = await replay(calledLater, platform(), { seed: 0, faults: [] });
  expect(answers(log)).toEqual([1, "Error: the counter gave up", 1]);
  expect(await reasons(calledLater)).toEqual([resetItself]);
});

test("an object that resets itself after it answered, so that no call fails, is named too", async () => {
  const log = await replay(quitsAfterAnswering, platform(), { seed: 0, faults: [] });
  // Every call answered; the last one in a new instance.
  expect(answers(log)).toEqual([1, "ok", 1]);
  expect(await reasons(quitsAfterAnswering)).toEqual([resetItself]);
});

test("an object that resets itself twice in a run is named once", async () => {
  const log = await replay(quitsTwice, platform(), { seed: 0, faults: [] });
  expect(answers(log)).toEqual(["Error: the counter gave up", "Error: the counter gave up", 1]);
  expect(await reasons(quitsTwice)).toEqual([resetItself]);
});

test("a class the simulation gave no base of its own is seen too, from its first entry", async () => {
  const verdict = await check(calledLater, platformWithoutExports(), {
    seed: "gate",
    maxRuns: 2,
    budgetMs: 30_000,
  });
  expect(verdict.kind, told(verdict)).toBe("UNSUPPORTED");
  if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain(resetItself);
});

test("the same reset with no later call, or with the same request calling again, is named, and the snapshot adds that it found the object rebuilt", async () => {
  expect(await reasons(leftAlone)).toEqual([resetItself, reconstructed]);
  // Through the stub the reset broke, the request's next call fails with the object's reason.
  const log = await replay(calledAgain, platform(), { seed: 0, faults: [] });
  expect(answers(log)).toEqual([1, "Error: the counter gave up", "Error: the counter gave up"]);
  expect(await reasons(calledAgain)).toEqual([resetItself, reconstructed]);
});

test("a call that only fails is no reset: the next call enters the same instance, and the run is BOUNDED", async () => {
  const log = await replay(refusedThenCalled, platform(), { seed: 0, faults: [] });
  // The instance kept its memory: it answers 2.
  expect(answers(log)).toEqual([1, "Error: the counter refused", 2]);
  expect(lastSnapshot(log as never, "DO:COUNTER")?.["c/counts"]).toEqual([{ id: "a", n: 2 }]);

  const verdict = await verdictOf(refusedThenCalled);
  expect(verdict.kind, told(verdict)).toBe("BOUNDED");
});
