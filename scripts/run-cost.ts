/**
 * The v0.18 gate on what a run costs: a run of the `agent-poll` example's fixed scenario (an Agent,
 * two votes in flight, a scheduled close) against a run of `workflow-approval`'s (a Workflow, one
 * invocation at a time), both through `eutaxy check` on the same machine. A run's cost is the time
 * a check of 101 runs takes beyond a check of one, over 100, so the command's own start-up cancels
 * out, and the ratio of the two cancels the machine's speed. The check job runs it after
 * `pnpm check`, alone, so the suite's parallel files do not load the machine meanwhile.
 *
 *   node scripts/run-cost.ts
 *
 * Prints both costs and the ratio, and exits 1 when the ratio is above `limit`.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The most a run of `agent-poll` may cost, in runs of `workflow-approval`. Measured by this
 * script at abce779: 8.4 to 9.0 times on a development machine (66 to 74 ms against 7.3 to 8.3 ms),
 * 9.1 on the CI runner (73.2 ms against 8.1 ms);
 * the limit leaves room for that spread and stops a change that makes an object's run dearer by a
 * third. An object's run pays a real
 * zero timer (about 1.2 ms in workerd, which has no cheaper turn of its event loop) at each handoff
 * into and out of the object's I/O context, where a move inside it cannot wake the scheduler; see
 * docs/roadmap.md, v0.18.
 */
export const limit = 12;

/** Runs of the longer check: the cost of one run is its time beyond a check of one run, over `runs - 1`. */
export const runs = 101;

/** What one scenario's run costs: the times of a check of one run and of `runs` runs, in ms. */
export interface Timing {
  readonly one: number;
  readonly many: number;
}

/** The cost of one run, in ms, from a check of one run and one of `count` runs. */
export function perRun(t: Timing, count: number = runs): number {
  return Math.max(0, t.many - t.one) / (count - 1);
}

/** The gate's verdict on the two costs. */
export function verdict(
  object: Timing,
  ordinary: Timing,
  max: number = limit,
): {
  readonly objectMs: number;
  readonly ordinaryMs: number;
  readonly ratio: number;
  readonly ok: boolean;
} {
  const objectMs = perRun(object);
  const ordinaryMs = perRun(ordinary);
  const ratio = ordinaryMs > 0 ? objectMs / ordinaryMs : Number.POSITIVE_INFINITY;
  return { objectMs, ordinaryMs, ratio, ok: ratio <= max };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");
const scenarios = {
  object: "examples/agent-poll/poll.fixed.sim.ts",
  ordinary: "examples/workflow-approval/expenses.fixed.sim.ts",
} as const;

/** The wall time of one `eutaxy check` of `scenario` with this run cap, in ms; throws unless it is BOUNDED. */
function timeCheck(scenario: string, maxRuns: number): number {
  const args = [bin, "check", scenario, "--max-runs", String(maxRuns)];
  const options = ["--budget-ms", "600000", "--seed", "run-cost", "--no-regression"];
  const start = performance.now();
  const r = spawnSync(process.execPath, [...args, ...options], { cwd: root, encoding: "utf8" });
  const ms = performance.now() - start;
  if (r.status !== 0)
    throw new Error(
      `${scenario} with ${maxRuns} run(s) exited ${r.status}:\n${r.stdout}${r.stderr}`,
    );
  return ms;
}

/**
 * Each scenario's checks, the two interleaved and each time the least of `repeats`, so a moment
 * the machine was busy weighs on neither.
 */
function measure(repeats: number): { object: Timing; ordinary: Timing } {
  const best = {
    object: { one: Infinity, many: Infinity },
    ordinary: { one: Infinity, many: Infinity },
  };
  for (let i = 0; i < repeats; i++)
    for (const key of ["object", "ordinary"] as const) {
      best[key].one = Math.min(best[key].one, timeCheck(scenarios[key], 1));
      best[key].many = Math.min(best[key].many, timeCheck(scenarios[key], runs));
    }
  return best;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { object, ordinary } = measure(2);
  const v = verdict(object, ordinary);
  console.log(
    `a run of ${scenarios.object}: ${v.objectMs.toFixed(1)} ms; of ${scenarios.ordinary}: ${v.ordinaryMs.toFixed(1)} ms; ratio ${v.ratio.toFixed(2)} (at most ${limit})`,
  );
  if (!v.ok) {
    console.error(`the ratio ${v.ratio.toFixed(2)} is above ${limit}`);
    process.exit(1);
  }
}
