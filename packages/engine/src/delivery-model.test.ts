/**
 * The loops that deliver held to the delivery model core proves
 * (`deliveries`): a platform that decides a redelivery by core's rule, its
 * handler's outcomes scripted, is run by each loop, and every event is
 * delivered exactly as often as the model says, attempt by attempt. The
 * loop that delivers one event at a time; the loop that takes turns, with
 * one slot (a second event waiting for it), with two slots and two events
 * in flight, and with two slots and three events, under every order of
 * turns; the next attempt handed back as a follow-up or queued for later,
 * as an alarm's retry is; and the loop of the differential runner's raw
 * side. On every list of outcomes and every pair of limits up to a bound:
 * exhaustive within the bounds, not sampled. Every list is at least as
 * long as the most deliveries its limits allow: a loop never ends a run
 * while an event is pending, so the list's end, the run's end in the
 * model, ends none here.
 */
import {
  type Bounds,
  type DeliveryResult,
  deliveries,
  type EventRef,
  invocationOf,
  type Platform,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { runInvocation } from "./deliver.ts";
import { rawRun } from "./differential.ts";
import { ExhaustiveDriver } from "./exhaustive.ts";
import { runOnce } from "./once.ts";
import { Run } from "./run.ts";

/** How the platform gives the loop an event's next attempt: in the delivery's result, or queued for a later time. */
type Handing = "follow-up" | "queued";

/** An event and whether each of its deliveries in turn is handled. */
interface Scripted {
  readonly id: string;
  readonly handled: readonly boolean[];
}

/**
 * A platform whose handler does what the script says: one effect, so a
 * concurrent run has a turn to order, then a return (handled) or a throw
 * (not handled). An attempt that was not handled is delivered again as
 * core's `redelivery` says, under the platform's `limit`. `delivered` is
 * every delivery the loop made, in the order it made them.
 */
function scriptedPlatform(
  events: readonly Scripted[],
  limit: number,
  handing: Handing,
): Platform & { readonly delivered: string[] } {
  const delivered: string[] = [];
  return {
    name: "scripted",
    assumptions: [],
    concurrent: true,
    delivered,
    async reset() {
      delivered.length = 0;
    },
    initialEvents: () => events.map((e) => ({ id: e.id, attempt: 1, data: null })),
    restrictEvents: (spec) => spec,
    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const invocation = invocationOf(event);
      delivered.push(invocation);
      const handled = events.find((e) => e.id === event.id)?.handled[event.attempt - 1];
      if (handled === undefined) throw new Error(`${invocation} is past the end of its outcomes`);
      const inv = hooks.startInvocation(invocation);
      const { status } = await runInvocation(hooks, inv, async () => {
        await hooks.effect(
          { invocation, target: "Store", op: "work", args: null, allowed: [] },
          async () => null,
          () => null,
        );
        if (!handled) throw new Error("not handled");
      });
      const next = status === "completed" ? null : redelivery(event, limit, spec.bounds);
      if (next === null) return { status, followUps: [] };
      if (handing === "follow-up") return { status, followUps: [next] };
      hooks.enqueue({ ...next, at: Date.now() + 1_000 });
      return { status, followUps: [] };
    },
  };
}

function specWith(bounds: Bounds): ScenarioSpec {
  return {
    version: 1,
    name: "delivery-model",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: { kind: "scripted" },
    setup: [],
    externals: [],
    invariants: [],
    bounds,
  };
}

/** Every list of `length` outcomes. */
function outcomes(length: number): boolean[][] {
  return Array.from({ length: 2 ** length }, (_, bits) =>
    Array.from({ length }, (_, i) => ((bits >> i) & 1) === 1),
  );
}

/** The deliveries of one event among those a run made are its attempts in order, as many as the model says for its outcomes. */
function expectAsTheModel(
  delivered: readonly string[],
  event: Scripted,
  limit: number,
  maxRedeliveries: number,
): void {
  const made = delivered.filter((d) => d.startsWith(`${event.id}#`));
  const count = deliveries(event.handled, limit, maxRedeliveries);
  expect(made).toEqual(Array.from({ length: count }, (_, i) => `${event.id}#${i + 1}`));
}

/** The bounds of a run without faults, with this bound on redeliveries and this many slots. */
function boundsOf(maxRedeliveries: number, maxConcurrentInvocations: number): Bounds {
  return { maxFaultsPerRun: 0, maxRedeliveries, maxConcurrentInvocations, budgetMs: 10_000 };
}

/** Run the scenario under every order of turns, each run checked; how many schedules that was. */
async function everyOrder(
  spec: ScenarioSpec,
  platform: Platform,
  check: () => void,
): Promise<number> {
  const driver = new ExhaustiveDriver(false, 0);
  while (driver.hasMore) {
    const run = new Run({ bounds: spec.bounds, chooser: driver.next(), turns: true });
    await runOnce(spec, platform, run);
    expect(driver.mismatch).toBeNull();
    expect(run.unsupportedReasons).toEqual([]);
    driver.ran(() => false);
    check();
  }
  return driver.reached.schedules;
}

describe("the loops that deliver refine the proved delivery model", () => {
  // Six outcomes under limits up to four: every limit is passed by a list that goes on beyond it.
  const lists = outcomes(6);
  const limits = [0, 1, 2, 3, 4];
  // The same for the cases with several events, whose schedules multiply: four outcomes, limits up to two.
  const few = outcomes(4);
  const low = [0, 1, 2];
  const handings: Handing[] = ["follow-up", "queued"];

  test("one event at a time: every list of six outcomes under every limit and bound up to four", async () => {
    for (const handled of lists)
      for (const limit of limits)
        for (const maxRedeliveries of limits)
          for (const handing of handings) {
            const event = { id: "e", handled };
            const platform = scriptedPlatform([event], limit, handing);
            const bounds = boundsOf(maxRedeliveries, 1);
            const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
            await runOnce(specWith(bounds), platform, run);
            expectAsTheModel(platform.delivered, event, limit, maxRedeliveries);
          }
  });

  test("the loop that takes turns, one slot: every list of six outcomes under every limit and bound up to four", async () => {
    for (const handled of lists)
      for (const limit of limits)
        for (const maxRedeliveries of limits)
          for (const handing of handings) {
            const event = { id: "e", handled };
            const platform = scriptedPlatform([event], limit, handing);
            await everyOrder(specWith(boundsOf(maxRedeliveries, 1)), platform, () =>
              expectAsTheModel(platform.delivered, event, limit, maxRedeliveries),
            );
          }
  });

  test.each([
    { slots: 1, title: "one slot and a second event waiting for it" },
    { slots: 2, title: "two slots and two events in flight, under every order of turns" },
  ])(
    "the loop that takes turns, $title: every pair of lists of four outcomes under every limit and bound up to two",
    async ({ slots }) => {
      let scenarios = 0;
      let schedules = 0;
      for (const first of few)
        for (const second of few)
          for (const limit of low)
            for (const maxRedeliveries of low)
              for (const handing of handings) {
                const events = [
                  { id: "a", handled: first },
                  { id: "b", handled: second },
                ];
                const platform = scriptedPlatform(events, limit, handing);
                scenarios++;
                schedules += await everyOrder(
                  specWith(boundsOf(maxRedeliveries, slots)),
                  platform,
                  () => {
                    for (const event of events)
                      expectAsTheModel(platform.delivered, event, limit, maxRedeliveries);
                  },
                );
              }
      // With one slot there is one order; with two the events' turns interleave, several schedules to a scenario.
      if (slots === 1) expect(schedules).toBe(scenarios);
      else expect(schedules).toBeGreaterThan(2 * scenarios);
    },
  );

  test("the loop that takes turns, two slots and three events, one waiting for a slot: every three lists of two outcomes under every limit and bound up to one, under every order of turns", async () => {
    // Two outcomes are as many deliveries as a limit of one allows.
    const short = outcomes(2);
    let scenarios = 0;
    let schedules = 0;
    for (const first of short)
      for (const second of short)
        for (const third of short)
          for (const limit of [0, 1])
            for (const maxRedeliveries of [0, 1]) {
              const events = [
                { id: "a", handled: first },
                { id: "b", handled: second },
                { id: "c", handled: third },
              ];
              const platform = scriptedPlatform(events, limit, "follow-up");
              scenarios++;
              schedules += await everyOrder(
                specWith(boundsOf(maxRedeliveries, 2)),
                platform,
                () => {
                  for (const event of events)
                    expectAsTheModel(platform.delivered, event, limit, maxRedeliveries);
                },
              );
            }
    expect(schedules).toBeGreaterThan(2 * scenarios);
  });

  test("the differential runner's raw side: every list of six outcomes under every limit and bound up to four", async () => {
    for (const handled of lists)
      for (const limit of limits)
        for (const maxRedeliveries of limits) {
          const event = { id: "e", handled };
          const attempts = await rawRun(specWith(boundsOf(maxRedeliveries, 1)), {
            events: [{ id: event.id, attempt: 1, data: null }],
            limit,
            install: () => ({
              attempt: async (attempt) => ({
                record: invocationOf(attempt),
                handled: handled[attempt.attempt - 1] ?? false,
              }),
            }),
          });
          expectAsTheModel(attempts, event, limit, maxRedeliveries);
        }
  });
});
