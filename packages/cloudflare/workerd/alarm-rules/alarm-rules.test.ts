/**
 * Runs inside workerd: the alarms of real objects held to the alarm's
 * rules, whose claims are proved (`alarm-rules.props.ts`). An alarm event
 * runs its handler exactly when the rule says it is not superseded: one
 * object for every list of up to four changes made after its alarm was
 * first set, each setting it again or deleting it, with an alarm that was
 * replaced still pending when its replacement fires. And a failing
 * alarm's retries wait as the rule says, through all six. Exhaustive
 * within the bounds, not sampled, and each expectation is also written
 * out without the rule's functions.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  alarmRetries,
  createCloudflarePlatform,
  generationAfter,
  retryDelayMs,
  superseded,
} from "@eutaxy/cloudflare";
import type { Platform } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { expect, test } from "vitest";
import { changed, failing, lists, retried } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const reminders = (env as unknown as worker.Env).REMINDER;

/** Runs the scenario once without faults; the log, and the generation of every alarm event the run loop delivered, per object. */
async function run(spec: typeof changed) {
  const inner = createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });
  const delivered = new Map<string, number[]>();
  const platform: Platform = {
    ...inner,
    deliver(event, hooks, s) {
      const alarm = /^alarm:REMINDER:(\w+):(\d+)$/.exec(event.id);
      if (alarm?.[1] !== undefined)
        delivered.set(alarm[1], [...(delivered.get(alarm[1]) ?? []), Number(alarm[2])]);
      return inner.deliver(event, hooks, s);
    },
  };
  worker.ran.clear();
  const once = new Run({ bounds: spec.bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
  const log = await runOnce(spec, platform, once);
  expect(once.unsupportedReasons).toEqual([]);
  return { log, delivered };
}

test("an alarm event runs its handler exactly when the rule says it is not superseded: every list of up to four changes", async () => {
  expect(lists).toHaveLength(31);
  const { log, delivered } = await run(changed);
  for (const { object, changes } of lists) {
    const told = `changes ${JSON.stringify(changes)}`;
    // The alarm's first setting is a change like the others, the first of the object's generations.
    const all = [true, ...changes];
    const current = generationAfter(0, all);
    expect(current, told).toBe(all.length);
    // Every setting made an event, of the generation it started.
    const set = all.flatMap((isSet, i) => (isSet ? [i + 1] : []));
    expect([...(delivered.get(object) ?? [])].sort(), told).toEqual(set);
    // The events whose handler was entered, by the alarm effect each recorded.
    const fired = set.filter((generation) =>
      log.entries.some(
        (e) =>
          e.kind === "call" &&
          e.op === "alarm" &&
          e.invocation === `alarm:REMINDER:${object}:${generation}#1`,
      ),
    );
    expect(fired, told).toEqual(set.filter((generation) => !superseded(generation, current)));
    // The same written out: only the last change counts, and the alarm fires once when it set one.
    const lastSet = all[all.length - 1] === true;
    expect(fired, told).toEqual(lastSet ? [all.length] : []);
    expect(worker.ran.get(reminders.idFromName(object).toString()) ?? [], told).toHaveLength(
      lastSet ? 1 : 0,
    );
  }
});

test("a failing alarm's retries wait as the rule says: two seconds, doubled through all six", async () => {
  await run(retried);
  const runs = worker.ran.get(reminders.idFromName(failing).toString()) ?? [];
  expect(alarmRetries).toBe(6);
  expect(runs.map((r) => r.retryCount)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  // Virtual time moves a little while a handler runs: the wait is read to the tenth of a second.
  const waits = runs.slice(1).map((r, i) => Math.round((r.at - (runs[i]?.at ?? 0)) / 100) * 100);
  expect(waits).toEqual(runs.slice(1).map((_, i) => retryDelayMs(i)));
  expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
});
