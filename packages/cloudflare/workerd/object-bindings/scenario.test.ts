/**
 * Runs inside workerd: an object's remaining bindings. A Workflow binding
 * on an object's own env is the model's, as the Worker's is: creating an
 * instance, finding one and asking how it stands are effects of the
 * invocation the object's code runs as, and the instance runs the
 * scenario's class as an event of the run. A call on a binding the simulation does not model is refused from
 * inside an object as it is from the Worker.
 *
 * The checks: every schedule with one fault at one invocation in flight is
 * BOUNDED, exhaustively, and so are 50 seeded runs of two in flight with up
 * to two faults a run (runs with two faults at one in flight are not
 * explored here). The replays pin where
 * each call is recorded and what each fault on one does.
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

test("every schedule with one fault, one invocation in flight, holds exhaustively", async () => {
  const verdict = await check(jobs(1, 1), platform(), {
    seed: "gate",
    budgetMs: 60_000,
    exhaustive: true,
    now: untimed,
    maxRuns: 1_000,
  });
  expect(verdict.kind, told(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

// A sampled run places up to two faults: none in a tenth of the runs, else the first at an effect
// drawn from those a fault-free run makes, so these runs cover schedules with none or one too.
test("two invocations in flight, up to two faults a run, 50 seeded runs: BOUNDED", async () => {
  const verdict = await check(jobs(2, 2), platform(), {
    seed: "gate",
    budgetMs: 30_000,
    maxRuns: 50,
  });
  expect(verdict.kind, told(verdict)).toBe("BOUNDED");
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
  expect(verdict.kind, told(verdict)).toBe("UNSUPPORTED");
  expect(JSON.stringify(verdict)).toContain("binding CACHE is not proxied");
});
