/**
 * Runs inside workerd: the first part of the v0.17 gate. An object's calls
 * through its own service bindings are the scenario's: answered from the
 * service() scripts, recorded as effects of the invocation the object's code
 * runs as (the call it is serving, or its own work after the answer), and
 * open to faults, with what the object wrote before a call kept when a
 * fault resets it after.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { jobs } from "./scenario.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

const ops = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

interface RunRow {
  id: string;
  status: string;
  steps: number | null;
  charge_id: string | null;
}

/** The object's runs after the last event, by id. */
const runs = (log: EffectLog): RunRow[] =>
  [...((lastSnapshot(log as never, "DO:JOBS")?.["j/runs"] ?? []) as unknown as RunRow[])].sort(
    (a, b) => (a.id < b.id ? -1 : 1),
  );

const after = "DO:JOBS/j/after";

async function replayed(concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(jobs(concurrency, 2), platform(), schedule);
  return { lines: ops(log), runs: runs(log) };
}

/** The charges the watchdog alarm made. */
const byTheWatchdog = (lines: readonly string[]) =>
  lines.filter((l) => l.startsWith("alarm:JOBS:j:") && l.endsWith("call Service:BILLING charge"));
const watchdogRan = (lines: readonly string[]) =>
  lines.some((l) => l.startsWith("alarm:JOBS:j:") && l.endsWith("result DO:JOBS alarm"));

describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  test.each([0, 1, 2])(
    "up to %i fault(s): BOUNDED, or the object reset by the run's last event",
    async (faults) => {
      const verdict = await check(jobs(concurrency, faults), platform(), {
        seed: "gate",
        budgetMs: 30_000,
        maxRuns: 150,
      });
      if (faults > 0 && verdict.kind === "UNSUPPORTED") {
        // A crash on a call the watchdog alarm makes resets the object in the run's last event: it would
        // be constructed outside the simulation for the snapshot, which the model reports rather than
        // guesses (docs/design.md, Durable Objects).
        expect(verdict.reason).toContain("reconstructed for the snapshot");
        return;
      }
      expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
    },
  );
});

test("every schedule with one fault holds, exhaustively", async () => {
  const verdict = await check(jobs(1, 1), platform(), {
    seed: "gate",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

describe("where the object's calls are recorded", () => {
  test("inside a call they are the calling invocation's; in work after the answer, the object's own", async () => {
    const { lines, runs } = await replayed(1, { seed: 0, faults: [] });
    // The quote: the object asks the model inside the call it is serving.
    expect(lines.filter((l) => l.startsWith("quote-1#1 ")).slice(0, 4)).toEqual([
      "quote-1#1 call DO:JOBS quote",
      "quote-1#1 call Service:MODEL estimate",
      "quote-1#1 result Service:MODEL estimate",
      "quote-1#1 result DO:JOBS quote",
    ]);
    // The runs: each answered, then its plan and its charge, as the object's own invocation.
    expect(lines.filter((l) => l === `${after} result Service:MODEL plan`)).toHaveLength(2);
    expect(lines.filter((l) => l === `${after} result Service:BILLING charge`)).toHaveLength(2);
    expect(lines.indexOf(`${after} call Service:MODEL plan`)).toBeGreaterThan(
      lines.indexOf("run-1#1 result Http:/runs/run-1 response"),
    );
    expect(watchdogRan(lines)).toBe(true);
    expect(byTheWatchdog(lines)).toEqual([]);
    expect(runs).toEqual([
      { id: "run-1", status: "charged", steps: 2, charge_id: "ch-1" },
      { id: "run-2", status: "charged", steps: 2, charge_id: "ch-1" },
    ]);
  });

  test("the same seed gives the same run, and two in flight interleave the object's calls by the seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const once = await replayed(2, { seed, faults: [] });
      const twice = await replayed(2, { seed, faults: [] });
      expect(twice.lines).toEqual(once.lines);
      expect(once.runs.map((r) => r.status)).toEqual(["charged", "charged"]);
      orders.add(once.lines.filter((l) => l.includes(" call ")).join("\n"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("faults on the object's own calls", () => {
  const onCharge = (fault: "crash_after" | "ambiguous" | "error") => ({
    invocation: after,
    // In a sequential run the first run's job runs to rest before the second starts: its plan is the
    // object's first effect, its charge the second.
    ordinal: 1,
    fault,
    target: "Service:BILLING",
    op: "charge",
  });
  const statuses = (rows: readonly RunRow[]) => rows.map((r) => [r.id, r.status]);

  test("an answer lost on the charge is the object's to catch: the run stays charging, and the watchdog does not bill it again", async () => {
    const { lines, runs } = await replayed(1, { seed: 0, faults: [onCharge("ambiguous")] });
    expect(lines).toContain(`${after} fault Service:BILLING charge`);
    // run-1 was billed once and not recorded; run-2 is charged as usual; the watchdog finds nothing queued.
    expect(lines.filter((l) => l.endsWith("call Service:BILLING charge"))).toHaveLength(2);
    expect(watchdogRan(lines)).toBe(true);
    expect(byTheWatchdog(lines)).toEqual([]);
    expect(statuses(runs)).toEqual([
      ["run-1", "charging"],
      ["run-2", "charged"],
    ]);
  });

  test("a crash right after the charge resets the object, and the claim it wrote before the call is kept", async () => {
    const { lines, runs } = await replayed(1, { seed: 0, faults: [onCharge("crash_after")] });
    expect(lines).toContain(`${after} fault Service:BILLING charge`);
    // The claim was durable before the charge left, as behind the output gate: the object that comes
    // back after the reset finds run-1 charging, not queued, and the watchdog bills nothing.
    expect(watchdogRan(lines)).toBe(true);
    expect(byTheWatchdog(lines)).toEqual([]);
    expect(statuses(runs)).toEqual([
      ["run-1", "charging"],
      ["run-2", "charged"],
    ]);
  });

  test("a call that never reached billing leaves the run claimed and unbilled", async () => {
    const { lines, runs } = await replayed(1, { seed: 0, faults: [onCharge("error")] });
    expect(lines.filter((l) => l.endsWith("result Service:BILLING charge"))).toHaveLength(1);
    expect(statuses(runs)).toEqual([
      ["run-1", "charging"],
      ["run-2", "charged"],
    ]);
  });
});
