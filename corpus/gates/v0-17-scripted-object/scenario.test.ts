/**
 * Runs inside workerd: the gate entry for a scripted Durable Object. A
 * namespace the scenario scripts answers its objects' methods and fetch
 * from the script, each call an effect on `DO:<binding>` with a stub
 * call's faults, from the Worker and from another object, and no object
 * of the namespace is constructed.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, FaultKind, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { pool } from "./scenario.sim.ts";
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

/** The pool's jobs after the last event, as `id state warmed`, by id. */
const jobs = (log: EffectLog) =>
  (
    (lastSnapshot(log as never, "DO:POOL")?.["pool/jobs"] ?? []) as unknown as Record<
      string,
      string | number | null
    >[]
  )
    .map((r) => `${r["id"]} ${r["state"]} warmed=${r["warmed"]}`)
    .sort();

/** The first job runs, warm; the second ran, was warmed and was stopped. */
const settled = ["a running warmed=1", "b stopped warmed=1"];

async function replayed(concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(pool(concurrency, 2), platform(), schedule);
  return { log, lines: ops(log), jobs: jobs(log) };
}

const after = "DO:POOL/pool/after";

/** One fault on `invocation`'s call `target` `op`, placed by where that call comes in it. */
async function withFault(invocation: string, fault: FaultKind, target: string, op: string) {
  const base = await replay(pool(1, 2), platform(), { seed: 0, faults: [] });
  const calls = base.entries.filter((e) => e.kind === "call" && e.invocation === invocation);
  const ordinal = calls.findIndex((e) => e.target === target && e.op === op);
  expect(ordinal, `${target} ${op} in ${invocation}`).toBeGreaterThanOrEqual(0);
  return replayed(1, { seed: 0, faults: [{ invocation, ordinal, fault, target, op }] });
}

describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  test.each([0, 1, 2])("up to %i fault(s): BOUNDED, nothing unsupported", async (faults) => {
    const verdict = await check(pool(concurrency, faults), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      maxRuns: 150,
    });
    expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  });
});

test("every schedule with one fault holds, exhaustively", async () => {
  const verdict = await check(pool(1, 1), platform(), {
    seed: "gate",
    budgetMs: 100_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

describe("where the calls on a scripted object are recorded", () => {
  test("each an effect on the namespace, in the invocation the calling code runs as", async () => {
    const { log, lines, jobs } = await replayed(1, { seed: 0, faults: [] });
    // The pool calls the machine inside the Worker's call into it.
    expect(lines.filter((l) => l.startsWith("start-a#1 ")).slice(0, 4)).toEqual([
      "start-a#1 call DO:POOL start",
      "start-a#1 call DO:MACHINE boot",
      "start-a#1 result DO:MACHINE boot",
      "start-a#1 result DO:POOL start",
    ]);
    // After its answer the pool warms the machine as its own invocation, over HTTP.
    expect(lines.indexOf(`${after} call DO:MACHINE fetch`)).toBeGreaterThan(
      lines.indexOf("start-a#1 result Http:/jobs/a response"),
    );
    // The Worker asks a machine itself.
    expect(lines.filter((l) => l.startsWith("ask-a#1 ")).slice(0, 2)).toEqual([
      "ask-a#1 call DO:MACHINE status",
      "ask-a#1 result DO:MACHINE status",
    ]);
    // A scripted error reaches the pool as the error it is; the pool halts the machine anyway.
    expect(lines.filter((l) => l.startsWith("stop-b#1 ")).slice(0, 6)).toEqual([
      "stop-b#1 call DO:POOL stop",
      "stop-b#1 call DO:MACHINE snapshot",
      "stop-b#1 result DO:MACHINE snapshot",
      "stop-b#1 call DO:MACHINE halt",
      "stop-b#1 result DO:MACHINE halt",
      "stop-b#1 result DO:POOL stop",
    ]);
    const snapshot = log.entries.find((e) => e.kind === "result" && e.op === "snapshot");
    expect(JSON.stringify(snapshot?.payload)).toContain("snapshots are not enabled");
    // Each call names its object, and a fetch its request.
    const boot = log.entries.find((e) => e.kind === "call" && e.op === "boot");
    expect(boot?.payload).toEqual({ args: { object: "a", args: ["a"] } });
    const warm = log.entries.find((e) => e.kind === "call" && e.op === "fetch");
    expect(warm?.payload).toMatchObject({
      args: { object: "a", method: "POST", url: "http://machine/warm" },
    });
    expect(jobs).toEqual(settled);
  });

  test("the same seed gives the same run, and two in flight interleave the calls by the seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const once = await replayed(2, { seed, faults: [] });
      const twice = await replayed(2, { seed, faults: [] });
      expect(twice.lines).toEqual(once.lines);
      // The first job runs. The second was stopped, warm or not as the stop met its warm-up, or
      // runs still, when the stop came in before the start had claimed it.
      expect(once.jobs[0]).toBe("a running warmed=1");
      expect(once.jobs[1]).toMatch(/^b (stopped warmed=[01]|running warmed=1)$/);
      orders.add(once.lines.filter((l) => l.includes(" call ")).join("\n"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

/** The first job's calls on its machine, by invocation. */
const boots = (lines: readonly string[]) =>
  lines.filter((l) => l.startsWith("start-a#") && l.endsWith("call DO:MACHINE boot"));

describe("a fault on a call into a scripted object", () => {
  test("crash_before: the boot never left, and the pool is reset with the claim it had not made durable; the resend claims and boots", async () => {
    const { lines, jobs } = await withFault("start-a#1", "crash_before", "DO:MACHINE", "boot");
    expect(lines).toContain("start-a#1 fault DO:MACHINE boot");
    expect(lines).not.toContain("start-a#1 result DO:MACHINE boot");
    // The invocation ended there: no answer left the pool.
    expect(lines).not.toContain("start-a#1 result DO:POOL start");
    expect(lines).toContain("start-a#2 result DO:MACHINE boot");
    expect(jobs).toEqual(settled);
  });

  test("error: the call never reached the machine; the pool fails, and its caller's resend finds the job booting and boots it", async () => {
    const { lines, jobs } = await withFault("start-a#1", "error", "DO:MACHINE", "boot");
    expect(lines).toContain("start-a#1 fault DO:MACHINE boot");
    expect(lines).not.toContain("start-a#1 result DO:MACHINE boot");
    expect(boots(lines)).toHaveLength(2);
    expect(jobs).toEqual(settled);
  });

  test("ambiguous: the machine booted and the answer was lost; the resend boots the machine that runs", async () => {
    const { lines, jobs } = await withFault("start-a#1", "ambiguous", "DO:MACHINE", "boot");
    // It acted: the result is on record, and then the fault.
    expect(lines.indexOf("start-a#1 fault DO:MACHINE boot")).toBeGreaterThan(
      lines.indexOf("start-a#1 result DO:MACHINE boot"),
    );
    expect(boots(lines)).toHaveLength(2);
    expect(jobs).toEqual(settled);
  });

  test("crash_after: the pool died with the machine booted; the claim, durable before the boot left, is found, and the job runs", async () => {
    const { lines, jobs } = await withFault("start-a#1", "crash_after", "DO:MACHINE", "boot");
    expect(lines).toContain("start-a#1 result DO:MACHINE boot");
    expect(lines).toContain("start-a#1 fault DO:MACHINE boot");
    expect(lines).not.toContain("start-a#1 result DO:POOL start");
    expect(boots(lines)).toHaveLength(2);
    expect(jobs).toEqual(settled);
  });

  test("the warm-up after the answer failing: the watchdog warms the machine again", async () => {
    const { lines, jobs } = await withFault(after, "error", "DO:MACHINE", "fetch");
    expect(lines).toContain(`${after} fault DO:MACHINE fetch`);
    expect(
      lines.filter((l) => l.startsWith("alarm:POOL:pool:") && l.endsWith("call DO:MACHINE fetch")),
    ).toHaveLength(1);
    expect(jobs).toEqual(settled);
  });

  test("the Worker's own call failing is the Worker's to resend", async () => {
    const { lines } = await withFault("ask-a#1", "error", "DO:MACHINE", "status");
    expect(lines).toContain("ask-a#1 fault DO:MACHINE status");
    expect(lines).toContain("ask-a#2 result DO:MACHINE status");
  });
});

test("through all of it the runtime constructed no machine", () => {
  expect(worker.constructed.machines).toBe(0);
});
