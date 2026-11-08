/**
 * Runs inside workerd: the v0.16 object's timings around its answer, under
 * every fault placement. An object that awaits a timer of its own before
 * answering is woken by it, in a sequential run and with two such calls in
 * flight; an effect the object issued before its answer and did not await is
 * the object's own work once the call ended, so the caller's crash does not
 * end it and a fault in it resets the object, not the caller; real work the
 * object starts and does not await (a digest) keeps its work alive. Every
 * fault placement around the answer ends in a verdict.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { type Timing, timing } from "./scenario.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

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

const responses = (log: EffectLog) =>
  ops(log).filter((l) => / result Http:\/\S+ response$/.test(l));

async function replayed(method: Timing, concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(timing(method, concurrency), platform(), schedule);
  return { log, lines: ops(log), runs: runs(log) };
}

describe.each([1, 2] as const)("with %i call(s) in flight", (concurrency) => {
  test.each(["slow", "eager", "hashed"] as const)(
    "%s: both runs finish, each to a new total: BOUNDED, nothing unsupported",
    async (method) => {
      const verdict = await check(timing(method, concurrency), platform(), {
        seed: "gate",
        budgetMs: 30_000,
      });
      expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
    },
  );
});

describe("an object that awaits a timer of its own before answering", () => {
  test("is woken by it: the model call is the call's, the answer carries the total, and the same seed gives the same run", async () => {
    const first = await replayed("slow", 2, { seed: 0, faults: [] });
    const second = await replayed("slow", 2, { seed: 0, faults: [] });
    expect(second.lines).toEqual(first.lines);
    expect(first.lines.some((l) => l.startsWith("DO:RUNNER/r/after "))).toBe(false);
    expect(first.lines.filter((l) => /^run-\d#1 result Fetch:model POST$/.test(l))).toHaveLength(2);
    expect(responses(first.log)).toHaveLength(2);
    expect(first.runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test.each([1, 2] as const)(
    "a crash in the model call after the sleep (%i in flight) crashes the call and resets the object; the run ends in a verdict",
    async (concurrency) => {
      const { lines, runs, log } = await replayed("slow", concurrency, {
        seed: 0,
        faults: [
          {
            invocation: "run-1#1",
            ordinal: 1,
            fault: "crash_before",
            target: "Fetch:model",
            op: "POST",
          },
        ],
      });
      expect(lines).toContain("run-1#1 fault Fetch:model POST");
      expect(lines).not.toContain("run-1#1 result Http:/slow/run-1 response");
      expect(runs.find((r) => r.id === "run-1")?.status).toBe("queued");
      // The other call enters a fresh instance after the reset (on this seed, after it): its job goes through.
      expect(responses(log)).toEqual(["run-2#1 result Http:/slow/run-2 response"]);
      expect(runs.find((r) => r.id === "run-2")?.status).toBe("done");
    },
  );

  test("in a sequential run too, where the call's own wait fires the object's timer", async () => {
    const { lines, runs } = await replayed("slow", 1, { seed: 0, faults: [] });
    expect(lines.slice(0, 4)).toEqual([
      "run-1#1 call DO:RUNNER slow",
      "run-1#1 call Fetch:model POST",
      "run-1#1 result Fetch:model POST",
      "run-1#1 result DO:RUNNER slow",
    ]);
    expect(runs.map((r) => r.status)).toEqual(["done", "done"]);
  });
});

describe("an effect the object issued before its answer and did not await", () => {
  test("is the object's own turn once the answer crossed (two calls in flight), and the job finishes", async () => {
    const { lines, runs } = await replayed("eager", 2, { seed: 0, faults: [] });
    expect(lines.filter((l) => l === "DO:RUNNER/r/after result Fetch:model POST")).toHaveLength(2);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test("opened during the call in a sequential run, it stays the call's in the trace and completes after the answer", async () => {
    const { lines, runs } = await replayed("eager", 1, { seed: 0, faults: [] });
    // Opened inside the call, so the call's; its result and the answer land in the order the runtime
    // completes them (the scripted model answers within the call's own turn).
    expect(lines.slice(0, 2)).toEqual([
      "run-1#1 call DO:RUNNER eager",
      "run-1#1 call Fetch:model POST",
    ]);
    expect(lines.slice(2, 4).sort()).toEqual([
      "run-1#1 result DO:RUNNER eager",
      "run-1#1 result Fetch:model POST",
    ]);
    expect(lines.some((l) => l.startsWith("DO:RUNNER/r/after "))).toBe(false);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test("outlives the caller's crash after the answer: the job finishes though the response was never sent", async () => {
    const { lines, runs } = await replayed("eager", 1, {
      seed: 0,
      faults: [
        {
          invocation: "run-1#1",
          ordinal: 0,
          fault: "crash_after",
          target: "DO:RUNNER",
          op: "eager",
        },
      ],
    });
    expect(lines).toContain("run-1#1 fault DO:RUNNER eager");
    expect(lines).not.toContain("run-1#1 result Http:/eager/run-1 response");
    expect(runs.find((r) => r.id === "run-1")?.status).toBe("done");
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });

  test("a crash in it after the answer (two calls in flight) resets the object: the answers stand, the work is lost", async () => {
    const { lines, runs, log } = await replayed("eager", 2, {
      seed: 0,
      faults: [
        {
          invocation: "DO:RUNNER/r/after",
          ordinal: 0,
          fault: "crash_before",
          target: "Fetch:model",
          op: "POST",
        },
      ],
    });
    expect(responses(log)).toHaveLength(2);
    expect(lines).toContain("DO:RUNNER/r/after fault Fetch:model POST");
    expect(runs.some((r) => r.status === "queued")).toBe(true);
  });

  test("a crash in it during the call (sequential) crashes the call and resets the object; the next run still goes through", async () => {
    const { lines, runs, log } = await replayed("eager", 1, {
      seed: 0,
      faults: [
        {
          invocation: "run-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Fetch:model",
          op: "POST",
        },
      ],
    });
    expect(lines).toContain("run-1#1 fault Fetch:model POST");
    expect(lines).not.toContain("run-1#1 result Http:/eager/run-1 response");
    expect(responses(log)).toEqual(["run-2#1 result Http:/eager/run-2 response"]);
    expect(runs.find((r) => r.id === "run-2")?.status).toBe("done");
  });
});

describe("real work the object starts and does not await", () => {
  test("a digest after the answer keeps the work alive: the model call after it is the object's own, and both jobs finish", async () => {
    const { lines, runs } = await replayed("hashed", 2, { seed: 0, faults: [] });
    expect(lines.filter((l) => l === "DO:RUNNER/r/after result Fetch:model POST")).toHaveLength(2);
    expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
  });
});
