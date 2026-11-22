/**
 * Runs inside workerd: a Worker awaits calls into two objects together, one
 * invocation at a time. The two calls are turns, so which lands first is the
 * schedule's and the run replays.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform } from "@eutaxy/cloudflare";
import type { EffectLog } from "@eutaxy/core";
import { replay, replayRun } from "@eutaxy/engine";
import { expect, test } from "vitest";
import { told } from "../told.ts";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

/** The accounts a transfer's calls reached, in the order the calls were made. */
const reached = (log: EffectLog, transfer: string): string[] =>
  log.entries.flatMap((e) => {
    if (e.kind !== "call" || e.target !== "DO:ACCOUNT" || e.invocation !== `${transfer}#1`)
      return [];
    return [(e.payload as { args: { object: string } }).args.object];
  });

test("two calls awaited together, one invocation at a time: BOUNDED, with the calls interleaved as turns", async () => {
  const verdict = await check(scenario, platform(), {
    seed: "gate",
    budgetMs: 30_000,
    exhaustive: true,
    maxRuns: 1_000,
  });
  expect(verdict.kind, told(verdict)).toBe("BOUNDED");
  if (verdict.kind !== "BOUNDED") return;
  expect(verdict.reached.exhaustive?.complete).toBe(true);
  expect(verdict.assumptions.join("\n")).toContain(
    "one invocation at a time (maxConcurrentInvocations = 1), an object's work after its answer running to rest before the next event starts, the calls an invocation makes in parallel (two awaited together) interleaved only at asynchronous effects",
  );
});

test("which call lands first is the schedule's: each order replays, and the same schedule gives the same run", async () => {
  // The first decision with two options is between the first transfer's two calls.
  const debitFirst = { seed: 0, faults: [], turns: [0], effectsAsTurns: true } as const;
  const creditFirst = { seed: 0, faults: [], turns: [1], effectsAsTurns: true } as const;
  const one = await replay(scenario, platform(), debitFirst);
  const other = await replay(scenario, platform(), creditFirst);
  expect(reached(one, "t-1")).toEqual(["from", "to"]);
  expect(reached(other, "t-1")).toEqual(["to", "from"]);
  expect(await replay(scenario, platform(), creditFirst)).toEqual(other);
});

test("a schedule that says nothing of turns is replayed with them once the run shows the two calls", async () => {
  const run = await replayRun(scenario, platform(), { seed: 3, faults: [] });
  // The run kept is the one made again with every effect a turn.
  expect(run.schedule.effectsAsTurns).toBe(true);
  expect(run.unsupportedReasons).toEqual([]);
  expect(await replay(scenario, platform(), { seed: 3, faults: [] })).toEqual(run.log);
});

test("each account's work after its answer runs to rest before the next transfer starts, as one invocation at a time has it", async () => {
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const log = await replay(scenario, platform(), { seed, faults: [], effectsAsTurns: true });
    const lines = log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target}`);
    const second = lines.findIndex((l) => l.startsWith("t-2#1 "));
    const reported = lines.flatMap((l, i) =>
      /^DO:ACCOUNT\/(from|to)\/after result Fetch:audit$/.test(l) ? [i] : [],
    );
    // Four reports in all, and the first transfer's two are in before the second transfer starts.
    expect(reported, `seed ${seed}`).toHaveLength(4);
    expect(
      reported.filter((i) => i < second),
      `seed ${seed}`,
    ).toHaveLength(2);
  }
});
