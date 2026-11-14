/**
 * Runs inside workerd: the part of the v0.17 gate for an object's
 * remaining bindings. A Workflow binding on an object's own env is the
 * model's, as the Worker's is: creating an instance, finding one and
 * asking how it stands are effects of the invocation the object's code
 * runs as, and the instance runs the scenario's class as an event of the
 * run. A call on a binding the simulation does not model is refused from
 * inside an object as it is from the Worker.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { cached, jobs } from "./scenario.sim.ts";
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

/** The book's jobs and the engine's instances after the last event. */
function state(log: EffectLog) {
  const book = (lastSnapshot(log as never, "DO:JOBS")?.["book/jobs"] ?? []) as unknown as {
    id: string;
    status: string;
  }[];
  const runs = (lastSnapshot(log as never, "Workflow:RUNS")?.["instances"] ?? []) as unknown as {
    id: string;
    status: string;
  }[];
  return {
    jobs: Object.fromEntries(book.map((j) => [j.id, j.status])),
    runs: runs.map((r) => `${r.id} ${r.status}`).sort(),
  };
}

async function replayed(concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(jobs(concurrency, 2), platform(), schedule);
  return { lines: ops(log), state: state(log) };
}

const settled = {
  jobs: { a: "done", b: "done" },
  runs: ["run-a complete", "run-b complete"],
};

// A sampled run places up to two faults: none in a tenth of the runs, else the first at an effect
// drawn from those a fault-free run makes, so these runs cover schedules with none or one too. Every
// schedule with one fault at one in flight, and 150 seeded runs without a fault at two, are the checks below.
describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  test("up to 2 faults a run: BOUNDED, nothing unsupported", async () => {
    const verdict = await check(jobs(concurrency, 2), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      maxRuns: 150,
    });
    expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  });
});

test("every schedule with one fault holds, exhaustively", async () => {
  const verdict = await check(jobs(1, 1), platform(), {
    seed: "gate",
    budgetMs: 60_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

test("with 2 invocations in flight and no fault, 150 seeded runs: BOUNDED, nothing unsupported", async () => {
  // Every order without a fault at two in flight is too many to run each.
  const verdict = await check(jobs(2, 0), platform(), {
    seed: "gate",
    budgetMs: 30_000,
    maxRuns: 150,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

describe("where the object's calls on its Workflow binding are recorded", () => {
  test("the create in the call it is serving, the run as an event of its own, and the look through the instance", async () => {
    const { lines, state } = await replayed(1, { seed: 0, faults: [] });
    expect(lines.filter((l) => l.startsWith("job-1#1 ")).slice(0, 4)).toEqual([
      "job-1#1 call DO:JOBS submit",
      "job-1#1 call Workflow:RUNS create",
      "job-1#1 result Workflow:RUNS create",
      "job-1#1 result DO:JOBS submit",
    ]);
    // The instance runs the scenario's class, whose step calls back into the object.
    expect(lines).toContain("workflow:RUNS:run-a#1 call DO:JOBS finish");
    expect(lines.filter((l) => l.startsWith("look-1#1 ")).slice(0, 6)).toEqual([
      "look-1#1 call DO:JOBS progress",
      "look-1#1 call Workflow:RUNS get",
      "look-1#1 result Workflow:RUNS get",
      "look-1#1 call Workflow:RUNS status",
      "look-1#1 result Workflow:RUNS status",
      "look-1#1 result DO:JOBS progress",
    ]);
    expect(state).toEqual(settled);
  });

  test("the same seed gives the same run, and two in flight interleave the object's calls by the seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const once = await replayed(2, { seed, faults: [] });
      const twice = await replayed(2, { seed, faults: [] });
      expect(twice.lines).toEqual(once.lines);
      expect(once.state).toEqual(settled);
      orders.add(once.lines.filter((l) => l.includes(" call ")).join("\n"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("a fault around the create", () => {
  test("the instance created and its answer lost: the resend's create is refused by the engine, and the job has one run", async () => {
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [
        {
          invocation: "job-1#1",
          ordinal: 1,
          fault: "ambiguous",
          target: "Workflow:RUNS",
          op: "create",
        },
      ],
    });
    expect(lines).toContain("job-1#1 fault Workflow:RUNS create");
    expect(lines).toContain("job-1#2 call Workflow:RUNS create");
    expect(lines).toContain("job-1#2 result DO:JOBS submit");
    expect(state).toEqual(settled);
  });

  test("the object reset right after the instance was created: the job it had accepted is kept, and the resend records the run", async () => {
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [
        {
          invocation: "job-1#1",
          ordinal: 1,
          fault: "crash_after",
          target: "Workflow:RUNS",
          op: "create",
        },
      ],
    });
    expect(lines).toContain("job-1#1 fault Workflow:RUNS create");
    expect(lines).toContain("job-1#2 result DO:JOBS submit");
    expect(state).toEqual(settled);
  });

  test("the create never reaching the engine: the resend creates the instance", async () => {
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [
        {
          invocation: "job-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Workflow:RUNS",
          op: "create",
        },
      ],
    });
    expect(lines).toContain("job-1#1 fault Workflow:RUNS create");
    expect(lines).toContain("job-1#2 result Workflow:RUNS create");
    expect(state).toEqual(settled);
  });
});

test("a call on a binding the simulation does not model is refused from inside the object, as from the Worker", async () => {
  const verdict = await check(cached, platform(), { seed: "gate", budgetMs: 10_000 });
  expect(verdict.kind, renderText(verdict)).toBe("UNSUPPORTED");
  expect(renderText(verdict)).toContain("binding CACHE is not proxied");
});
