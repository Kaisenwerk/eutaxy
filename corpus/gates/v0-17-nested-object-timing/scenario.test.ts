/**
 * Runs inside workerd: the v0.16 gate's timings of an object around its
 * answer, with the object called by another object and not by the Worker.
 * Nested, each is what it is from the Worker: the runner asleep on a timer
 * of its own is woken though the object awaiting it is in flight too; an
 * effect it issued and did not await, and the real work it starts after
 * its answer, are its own work once its call ended; and a crash inside it
 * ends the invocation, resetting both objects. Every fault placement ends
 * in a verdict, with nothing unsupported.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { nested, type Timing } from "./scenario.sim.ts";
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

const runs = (log: EffectLog) =>
  (lastSnapshot(log as never, "DO:RUNNER")?.["r/runs"] ?? []) as {
    id: string;
    status: string;
    total: number | null;
  }[];

const passes = (log: EffectLog) =>
  (lastSnapshot(log as never, "DO:FRONT")?.["f/passes"] ?? []) as {
    id: string;
    answered: number;
  }[];

const responses = (log: EffectLog) =>
  ops(log).filter((l) => / result Http:\/\S+ response$/.test(l));

async function replayed(method: Timing, concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(nested(method, concurrency), platform(), schedule);
  return { log, lines: ops(log), runs: runs(log), passes: passes(log) };
}

describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  describe.each(["slow", "eager", "hashed"] as const)("%s", (method) => {
    test("both runs finish, each to a new total: BOUNDED, nothing unsupported", async () => {
      const verdict = await check(nested(method, concurrency), platform(), {
        seed: "gate",
        budgetMs: 30_000,
      });
      expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
    });

    test("under every placement of a fault: BOUNDED, nothing unsupported", async () => {
      const verdict = await check(nested(method, concurrency, 1), platform(), {
        seed: "gate",
        budgetMs: 30_000,
        maxRuns: 150,
      });
      expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
    });
  });
});

describe("a runner that awaits a timer of its own before answering, called by the front object", () => {
  test("is woken by it: the model call is the call's, the answer goes back through both objects, and the same seed gives the same run", async () => {
    const first = await replayed("slow", 2, { seed: 0, faults: [] });
    const second = await replayed("slow", 2, { seed: 0, faults: [] });
    expect(second.lines).toEqual(first.lines);
    expect(first.lines.some((l) => l.includes("/after "))).toBe(false);
    expect(first.lines.filter((l) => /^run-\d#1 result Fetch:model POST$/.test(l))).toHaveLength(2);
    expect(responses(first.log)).toHaveLength(2);
    expect(first.runs.map((r) => r.total).sort()).toEqual([2, 4]);
    expect(first.passes.map((p) => p.answered)).toEqual([1, 1]);
  });

  test("in a sequential run too: one call inside the other, each effect the request's", async () => {
    const { lines, runs } = await replayed("slow", 1, { seed: 0, faults: [] });
    expect(lines.slice(0, 6)).toEqual([
      "run-1#1 call DO:FRONT pass",
      "run-1#1 call DO:RUNNER slow",
      "run-1#1 call Fetch:model POST",
      "run-1#1 result Fetch:model POST",
      "run-1#1 result DO:RUNNER slow",
      "run-1#1 result DO:FRONT pass",
    ]);
    expect(runs.map((r) => r.status)).toEqual(["done", "done"]);
  });

  test.each([1, 2] as const)(
    "a crash in the model call after the sleep (%i in flight) ends the request and resets both objects; the run ends in a verdict",
    async (concurrency) => {
      const { lines, runs, passes, log } = await replayed("slow", concurrency, {
        seed: 0,
        faults: [
          {
            invocation: "run-1#1",
            ordinal: 2,
            fault: "crash_before",
            target: "Fetch:model",
            op: "POST",
          },
        ],
      });
      expect(lines).toContain("run-1#1 fault Fetch:model POST");
      expect(lines).not.toContain("run-1#1 result Http:/slow/run-1 response");
      expect(runs.find((r) => r.id === "run-1")?.status).toBe("queued");
      expect(passes.find((p) => p.id === "run-1")?.answered).toBe(0);
      // The other request was answered either way: by fresh instances after the reset, or, when the
      // schedule had it inside an instance the crash reset, with the runtime's error.
      expect(responses(log)).toEqual(["run-2#1 result Http:/slow/run-2 response"]);
    },
  );
});

describe("work the runner goes on with after its answer, called by the front object", () => {
  test("an effect it issued and did not await is its own turn once its answer crossed (two in flight), and the job finishes", async () => {
    const { lines, runs, passes } = await replayed("eager", 2, { seed: 0, faults: [] });
    expect(lines.filter((l) => l === "DO:RUNNER/r/after result Fetch:model POST")).toHaveLength(2);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
    expect(passes.map((p) => p.answered)).toEqual([1, 1]);
  });

  test("opened during the call in a sequential run, that effect stays the request's and both jobs finish", async () => {
    const { lines, runs } = await replayed("eager", 1, { seed: 0, faults: [] });
    expect(lines.slice(0, 3)).toEqual([
      "run-1#1 call DO:FRONT pass",
      "run-1#1 call DO:RUNNER eager",
      "run-1#1 call Fetch:model POST",
    ]);
    expect(lines.some((l) => l.includes("/after "))).toBe(false);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test("a digest after the answer keeps the work alive: the model call after it is the runner's own, and both jobs finish", async () => {
    const { lines, runs } = await replayed("hashed", 2, { seed: 0, faults: [] });
    expect(lines.filter((l) => l === "DO:RUNNER/r/after result Fetch:model POST")).toHaveLength(2);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test("a crash in the runner's work after its answer resets the runner alone: both requests were answered, and the front object noted both", async () => {
    const base = await replayed("eager", 2, { seed: 0, faults: [] });
    const after = "DO:RUNNER/r/after";
    const calls = base.log.entries.filter((e) => e.kind === "call" && e.invocation === after);
    const ordinal = calls.findIndex((e) => e.target === "Fetch:model");
    expect(ordinal).toBeGreaterThanOrEqual(0);
    const { lines, passes, log } = await replayed("eager", 2, {
      seed: 0,
      faults: [
        { invocation: after, ordinal, fault: "crash_before", target: "Fetch:model", op: "POST" },
      ],
    });
    expect(lines).toContain(`${after} fault Fetch:model POST`);
    expect(responses(log)).toHaveLength(2);
    expect(passes.map((p) => p.answered)).toEqual([1, 1]);
  });
});
