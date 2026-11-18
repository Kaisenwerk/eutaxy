/**
 * A ceiling on the test suite's time (the v0.18 gate): with `EUTAXY_SUITE_CEILING_S` set, as the
 * check job sets it, a run of the suite that takes longer fails, naming its slowest test files, so
 * growth like v0.17's (the check went from about 4 to 8.5 minutes on the CI runner in a week, and
 * was noticed by eye) stops the change that causes it. Unset, it does nothing: the time a
 * development machine takes is not the gate's.
 */

import type { Reporter, TestModule } from "vitest/node";

/** One test file's time: its own wall time in the worker that ran it, set-up included. */
export interface FileTime {
  readonly file: string;
  readonly ms: number;
}

/** How many of the slowest files a failure names. */
export const slowestShown = 10;

/** Whether a run of `wallMs` holds under `ceilingS`, and, when it does not, what to print. */
export function ceilingVerdict(
  wallMs: number,
  files: readonly FileTime[],
  ceilingS: number,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (wallMs <= ceilingS * 1000) return { ok: true };
  const slowest = [...files].sort((a, b) => b.ms - a.ms).slice(0, slowestShown);
  const width = Math.max(...slowest.map((f) => (f.ms / 1000).toFixed(1).length), 0);
  return {
    ok: false,
    message: [
      `The test suite took ${(wallMs / 1000).toFixed(1)} s, above its ceiling of ${ceilingS} s (docs/roadmap.md, v0.18). Its slowest files:`,
      ...slowest.map((f) => `  ${(f.ms / 1000).toFixed(1).padStart(width)} s  ${f.file}`),
      "",
    ].join("\n"),
  };
}

/** The ceiling from the environment, in seconds; undefined when unset, and an error when not a positive number. */
export function ceilingFrom(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const s = Number(value);
  if (!(Number.isFinite(s) && s > 0))
    throw new Error(
      `EUTAXY_SUITE_CEILING_S must be a positive number of seconds, got ${JSON.stringify(value)}`,
    );
  return s;
}

/** A file's time from what Vitest measured for it: environment, preparation, collection, set-up and its tests. */
function fileTime(m: TestModule): FileTime {
  const d = m.diagnostic();
  return {
    file: m.relativeModuleId,
    ms:
      d.environmentSetupDuration +
      d.prepareDuration +
      d.collectDuration +
      d.setupDuration +
      d.duration,
  };
}

/** The reporter: times the run from its start to its end and fails it above the ceiling. */
export class SuiteCeiling implements Reporter {
  private readonly ceilingS: number;
  private started = 0;

  constructor(ceilingS: number) {
    this.ceilingS = ceilingS;
  }

  onTestRunStart(): void {
    this.started = performance.now();
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    const verdict = ceilingVerdict(
      performance.now() - this.started,
      modules.map(fileTime),
      this.ceilingS,
    );
    if (verdict.ok) return;
    process.stderr.write(verdict.message);
    process.exitCode = 1;
  }
}
