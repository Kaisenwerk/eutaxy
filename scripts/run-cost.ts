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
 * Prints both costs and the ratio, and exits 1 when the ratio is above `limit`. A reading above the
 * limit is taken again (`readings`), since a busy machine alone can give one.
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

/**
 * The readings the gate takes before it fails, in all. One is enough while it is at or under the
 * limit, which is every run but a loaded one. A reading above the limit is taken again and the
 * least of each timing kept: load only ever adds to a check's time, so the least of a timing is the
 * nearest to what the code costs. A run dearer by well more than the readings' spread stays above
 * the limit however often it is read; one just above it can come out under, in one reading as in
 * three. On the CI runner unchanged code read 13.11 (91.0 ms against 6.9 ms) twenty minutes after
 * it read 9.19 (78.5 ms against 8.5 ms), where the fourteen green runs before had read 8.38 to
 * 9.93: the object's cost came out at its highest and the ordinary run's at its lowest in the same
 * reading. Load that lasts through all the readings still fails the gate.
 */
export const readings = 3;

/** Runs of the longer check: the cost of one run is its time beyond a check of one run, over `runs - 1`. */
export const runs = 101;

/** What one scenario's run costs: the times of a check of one run and of `runs` runs, in ms. */
export interface Timing {
  readonly one: number;
  readonly many: number;
}

/** One reading: both scenarios' timings, taken together. */
export interface Reading {
  readonly object: Timing;
  readonly ordinary: Timing;
}

/** The gate's verdict on a reading. */
export interface Verdict {
  readonly objectMs: number;
  readonly ordinaryMs: number;
  readonly ratio: number;
  readonly ok: boolean;
}

/** The cost of one run, in ms, from a check of one run and one of `count` runs. */
export function perRun(t: Timing, count: number = runs): number {
  return Math.max(0, t.many - t.one) / (count - 1);
}

/** The gate's verdict on the two costs. */
export function verdict(object: Timing, ordinary: Timing, max: number = limit): Verdict {
  const objectMs = perRun(object);
  const ordinaryMs = perRun(ordinary);
  const ratio = ordinaryMs > 0 ? objectMs / ordinaryMs : Number.POSITIVE_INFINITY;
  return { objectMs, ordinaryMs, ratio, ok: ratio <= max };
}

/** The least of each timing over two readings. */
export function least(a: Reading, b: Reading): Reading {
  const timing = (x: Timing, y: Timing): Timing => ({
    one: Math.min(x.one, y.one),
    many: Math.min(x.many, y.many),
  });
  return { object: timing(a.object, b.object), ordinary: timing(a.ordinary, b.ordinary) };
}

/**
 * The gate's verdict once it is settled: the first reading's while that is at or under the limit,
 * and otherwise the verdict on the least of each timing over as many readings as it takes to come
 * under, `readings` at the outside. A later reading that is under the limit by itself does not
 * settle it: a timing an earlier reading showed to be lower still counts. `report` is told each
 * reading as it was taken, and the verdict the gate holds after it.
 */
export function settle(
  read: () => Reading,
  report: (taken: number, reading: Reading, held: Verdict) => void = () => {},
): Verdict & { readonly taken: number } {
  let taken = 0;
  let best: Reading | undefined;
  for (;;) {
    const reading = read();
    taken++;
    best = best === undefined ? reading : least(best, reading);
    const held = verdict(best.object, best.ordinary);
    report(taken, reading, held);
    if (held.ok || taken >= readings) return { ...held, taken };
  }
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
function measure(repeats: number): Reading {
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
  const ms = (t: Timing): string => `${t.one.toFixed(0)} ms and ${t.many.toFixed(0)} ms`;
  const v = settle(
    () => measure(2),
    (taken, reading, held) => {
      // The four timings as read, so a reading above the limit shows which of them load moved.
      console.log(
        `reading ${taken} of ${readings}, a check of 1 run and of ${runs}: ${scenarios.object} ${ms(reading.object)}; ${scenarios.ordinary} ${ms(reading.ordinary)}`,
      );
      console.log(
        `a run of ${scenarios.object}: ${held.objectMs.toFixed(1)} ms; of ${scenarios.ordinary}: ${held.ordinaryMs.toFixed(1)} ms; ratio ${held.ratio.toFixed(2)} (at most ${limit}${taken > 1 ? `; the least of each timing over ${taken} readings` : ""})`,
      );
      if (!held.ok && taken < readings)
        console.log(`the ratio ${held.ratio.toFixed(2)} is above ${limit}; reading again`);
    },
  );
  if (!v.ok) {
    console.error(`the ratio ${v.ratio.toFixed(2)} is above ${limit} after ${v.taken} readings`);
    process.exit(1);
  }
}
