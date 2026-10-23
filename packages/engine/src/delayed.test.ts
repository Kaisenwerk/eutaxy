import type { EventRef, Platform, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { virtualEpoch } from "./clock.ts";
import { runOnce } from "./explore.ts";
import { Run } from "./run.ts";

/**
 * A platform whose events resend themselves once, after a delay given in the
 * event's data, and record the virtual time each attempt started at.
 */
function delayingPlatform(concurrent: boolean): Platform & { readonly starts: string[] } {
  const starts: string[] = [];
  return {
    name: "delaying",
    assumptions: [],
    concurrent,
    starts,
    async reset() {
      starts.length = 0;
    },
    restrictEvents: (spec) => spec,
    initialEvents: (spec) => spec.drive["events"] as unknown as EventRef[],
    async deliver(event: EventRef, hooks: RunHooks) {
      const invocation = `${event.id}#${event.attempt}`;
      hooks.startInvocation(invocation);
      starts.push(`${invocation}@${Date.now() - virtualEpoch}`);
      if (event.attempt === 1) {
        const delay = (event.data as { delay: number }).delay;
        hooks.enqueue({ ...event, attempt: 2, at: Date.now() + delay });
      }
      return { status: "completed" as const, followUps: [] };
    },
  };
}

function specFor(maxConcurrentInvocations: number): ScenarioSpec {
  return {
    version: 1,
    name: "delayed",
    worker: { entry: "./w.ts", config: "./w.jsonc" },
    drive: {
      kind: "delayed",
      events: [
        { id: "slow", attempt: 1, data: { delay: 5_000 } },
        { id: "fast", attempt: 1, data: { delay: 1_000 } },
      ],
    },
    setup: [],
    externals: [],
    invariants: [],
    bounds: { maxFaultsPerRun: 0, maxRedeliveries: 1, maxConcurrentInvocations, budgetMs: 10_000 },
  };
}

async function startsOf(maxConcurrentInvocations: number): Promise<string[]> {
  const spec = specFor(maxConcurrentInvocations);
  const platform = delayingPlatform(maxConcurrentInvocations > 1);
  const run = new Run({
    mode: "replay",
    schedule: { seed: 1, faults: [] },
    bounds: spec.bounds,
    faultProbability: 0,
  });
  await runOnce(spec, platform, run);
  return platform.starts;
}

describe("delayed events", () => {
  for (const cap of [1, 2]) {
    test(`are delivered in time order, not queue order (maxConcurrentInvocations ${cap})`, async () => {
      const starts = await startsOf(cap);
      // The fast resend (due at about 1 s) goes before the slow one (about 5 s) though queued after it.
      const resends = starts.filter((s) => s.includes("#2"));
      expect(resends.map((s) => s.split("@")[0])).toEqual(["fast#2", "slow#2"]);
      const at = (id: string) => Number(starts.find((s) => s.startsWith(id))?.split("@")[1]);
      expect(at("fast#2")).toBeGreaterThanOrEqual(1_000);
      expect(at("slow#2")).toBeGreaterThanOrEqual(5_000);
    });
  }

  test("a timer's continuation runs before time moves on to the next timer", async () => {
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: specFor(1).bounds,
      faultProbability: 0,
    });
    run.install();
    const seen: string[] = [];
    try {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        seen.push(`continuation@${Date.now() - virtualEpoch}`);
      })();
      setTimeout(() => seen.push(`timer@${Date.now() - virtualEpoch}`), 200);
      await run.advanceTo(virtualEpoch + 300);
    } finally {
      run.uninstall();
    }
    expect(seen).toEqual(["continuation@100", "timer@200"]);
  });

  test("letting time pass fires the timers due before the event, in due order", async () => {
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: specFor(1).bounds,
      faultProbability: 0,
    });
    run.install();
    const fired: number[] = [];
    try {
      setTimeout(() => fired.push(300), 300);
      setTimeout(() => fired.push(100), 100);
      await run.advanceTo(virtualEpoch + 200);
      expect(fired).toEqual([100]);
      expect(run.now()).toBe(virtualEpoch + 200);
      await run.advanceTo(virtualEpoch + 150);
      expect(run.now()).toBe(virtualEpoch + 200);
    } finally {
      run.uninstall();
    }
  });
});
