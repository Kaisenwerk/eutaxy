/**
 * Runs inside workerd: the v0.16 gate's first half. An object answers a call
 * and goes on with work it did not await; the work runs as the object's own
 * invocation after the answers, as turns of its own, and a crash in it resets
 * the object without touching the answer the caller got.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

const ops = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

test("two runs started at once both finish after their answers: BOUNDED, nothing unsupported", async () => {
  const verdict = await check(scenario, platform(), { seed: "gate", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.assumptions.join("\n")).toContain(
    "goes on after its answer as the object's own invocation",
  );
});

test("the work runs as the object's own invocation after the answers, and the same seed gives the same run", async () => {
  const first = await replay(scenario, platform(), { seed: 0, faults: [] });
  const second = await replay(scenario, platform(), { seed: 0, faults: [] });
  expect(ops(second)).toEqual(ops(first));
  const lines = ops(first);
  const answered = Math.max(
    ...lines.flatMap((l, i) =>
      l.endsWith("result Http:/runs/run-2 response") ||
      l.endsWith("result Http:/runs/run-1 response")
        ? [i]
        : [],
    ),
  );
  const afterWork = lines.flatMap((l, i) => (l.startsWith("DO:RUNNER/r/after ") ? [i] : []));
  // Both calls answered before any of the work: the model calls are the object's own, after.
  expect(afterWork.length).toBeGreaterThan(0);
  expect(Math.min(...afterWork)).toBeGreaterThan(answered);
  expect(lines.filter((l) => l === "DO:RUNNER/r/after result Fetch:model POST")).toHaveLength(2);
  const tables = lastSnapshot(first as never, "DO:RUNNER");
  expect(tables?.["r/totals"]).toEqual([{ id: "all", steps: 4 }]);
  const runs = (tables?.["r/runs"] ?? []) as { status: string; total: number }[];
  expect(runs.map((r) => r.status)).toEqual(["done", "done"]);
  // Each job brought the object to a new total: none was lost.
  expect(runs.map((r) => r.total).sort()).toEqual([2, 4]);
});

test("a crash in that work resets the object: the answers stand, the work is lost", async () => {
  const log = await replay(scenario, platform(), {
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
  const lines = ops(log);
  expect(
    lines.filter(
      (l) =>
        l.endsWith("result Http:/runs/run-1 response") ||
        l.endsWith("result Http:/runs/run-2 response"),
    ),
  ).toHaveLength(2);
  expect(lines).toContain("DO:RUNNER/r/after fault Fetch:model POST");
  const tables = lastSnapshot(log as never, "DO:RUNNER");
  expect(
    (tables?.["r/runs"] ?? []).some((r) => (r as { status: string }).status === "queued"),
  ).toBe(true);
});
