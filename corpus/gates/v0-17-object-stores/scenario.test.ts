/**
 * Runs inside workerd: the part of the v0.17 gate for an object's stores.
 * A statement an object runs on a D1 database and an operation it makes on
 * an R2 bucket, through its own env, are the scenario's: recorded as
 * effects of the invocation the object's code runs as (the call it is
 * serving, the call entering it while its constructor loads, or its own
 * work after the answer), and open to faults, with what the object wrote
 * before one kept when a fault resets it after.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { library } from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: { DB: schema },
    exports: worker,
    durableObjects: cloudflareTest,
  });

const ops = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

/** What each store holds after the last event. */
function state(log: EffectLog) {
  const names = (rows: unknown, column: string): string[] =>
    ((rows ?? []) as Record<string, string>[]).map((r) => r[column] ?? "").sort();
  const files = (lastSnapshot(log as never, "DO:LIBRARY")?.["lib/files"] ?? []) as unknown as {
    name: string;
    status: string;
  }[];
  return {
    files: Object.fromEntries(files.map((f) => [f.name, f.status])),
    catalogue: names(lastSnapshot(log as never, "D1:DB")?.["catalogue"], "name"),
    bucket: names(lastSnapshot(log as never, "R2:BUCKET")?.["objects"], "key"),
  };
}

const after = "DO:LIBRARY/lib/after";

async function replayed(concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(library(concurrency, 2), platform(), schedule);
  return { lines: ops(log), state: state(log) };
}

describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  test.each([0, 1, 2])("up to %i fault(s): BOUNDED, nothing unsupported", async (faults) => {
    const verdict = await check(library(concurrency, faults), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      maxRuns: 150,
    });
    expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  });
});

test("every schedule with one fault holds, exhaustively", async () => {
  const verdict = await check(library(1, 1), platform(), {
    seed: "gate",
    budgetMs: 60_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

describe("where the object's statements and bucket operations are recorded", () => {
  test("the constructor's in the call entering it, a call's in that call, and the work's after the answer in the object's own", async () => {
    const { lines, state } = await replayed(1, { seed: 0, faults: [] });
    // The first call constructs the object, whose constructor loads the limit behind its input gate;
    // then the call puts the bytes.
    expect(lines.filter((l) => l.startsWith("file-1#1 ")).slice(0, 6)).toEqual([
      "file-1#1 call DO:LIBRARY add",
      "file-1#1 call D1:DB first",
      "file-1#1 result D1:DB first",
      "file-1#1 call R2:BUCKET put",
      "file-1#1 result R2:BUCKET put",
      "file-1#1 result DO:LIBRARY add",
    ]);
    // The object is up: the second call loads nothing.
    expect(lines.filter((l) => l.startsWith("file-2#1 ") && l.includes("D1:DB"))).toEqual([]);
    // Each stored file is listed in work after its answer, as the object's own invocation.
    expect(lines.filter((l) => l === `${after} result D1:DB run`)).toHaveLength(2);
    expect(lines.indexOf(`${after} call D1:DB run`)).toBeGreaterThan(
      lines.indexOf("file-1#1 result Http:/files/a.txt response"),
    );
    // The third file is over the limit: nothing leaves the object for it.
    expect(lines.filter((l) => l.startsWith("file-3#1 ") && /D1:|R2:/.test(l))).toEqual([]);
    expect(state).toEqual({
      files: { "a.txt": "listed", "b.txt": "listed" },
      catalogue: ["a.txt", "b.txt"],
      bucket: ["a.txt", "b.txt"],
    });
  });

  test("the same seed gives the same run, and two in flight interleave the object's operations by the seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const once = await replayed(2, { seed, faults: [] });
      const twice = await replayed(2, { seed, faults: [] });
      expect(twice.lines).toEqual(once.lines);
      expect(once.state.catalogue).toEqual(["a.txt", "b.txt"]);
      orders.add(once.lines.filter((l) => l.includes(" call ")).join("\n"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("a fault between a write outside and the object's own record of it", () => {
  test("the row written and its answer lost: the object keeps the file as stored, and the watchdog lists it again, once", async () => {
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [{ invocation: after, ordinal: 0, fault: "ambiguous", target: "D1:DB", op: "run" }],
    });
    expect(lines).toContain(`${after} fault D1:DB run`);
    // The alarm finds a.txt still stored and writes the same row again.
    const byTheWatchdog = lines.filter(
      (l) => l.startsWith("alarm:LIBRARY:lib:") && l.endsWith("call D1:DB run"),
    );
    expect(byTheWatchdog).toHaveLength(1);
    expect(state).toEqual({
      files: { "a.txt": "listed", "b.txt": "listed" },
      catalogue: ["a.txt", "b.txt"],
      bucket: ["a.txt", "b.txt"],
    });
  });

  test("the object reset right after its bytes were put: the caller's resend puts them again, and the object's record comes with it", async () => {
    // The put is the call's second effect of its own (the constructor's read is the first).
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [
        {
          invocation: "file-1#1",
          ordinal: 2,
          fault: "crash_after",
          target: "R2:BUCKET",
          op: "put",
        },
      ],
    });
    expect(lines).toContain("file-1#1 fault R2:BUCKET put");
    // The next call into the object constructs it anew: it loads the limit again, inside that call.
    const afterTheCrash = lines.slice(lines.indexOf("file-1#1 fault R2:BUCKET put") + 1);
    expect(afterTheCrash.find((l) => l.endsWith("call D1:DB first"))).toBe(
      "file-2#1 call D1:DB first",
    );
    // The resend finds the object up and puts the bytes again.
    expect(lines.filter((l) => l.startsWith("file-1#2 ")).slice(0, 4)).toEqual([
      "file-1#2 call DO:LIBRARY add",
      "file-1#2 call R2:BUCKET put",
      "file-1#2 result R2:BUCKET put",
      "file-1#2 result DO:LIBRARY add",
    ]);
    expect(state.files).toEqual({ "a.txt": "listed", "b.txt": "listed" });
    expect(state.bucket).toEqual(["a.txt", "b.txt"]);
  });

  test("the constructor's read failing breaks the object for that call only: the resend constructs it again", async () => {
    const { lines, state } = await replayed(1, {
      seed: 0,
      faults: [
        { invocation: "file-1#1", ordinal: 1, fault: "error", target: "D1:DB", op: "first" },
      ],
    });
    expect(lines).toContain("file-1#1 fault D1:DB first");
    expect(lines).toContain("file-1#2 result DO:LIBRARY add");
    expect(state.catalogue).toEqual(["a.txt", "b.txt"]);
  });
});
