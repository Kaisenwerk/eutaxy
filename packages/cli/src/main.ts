import { parseArgs } from "./args.ts";
import { exitCodes, runCheck } from "./check.ts";
import { runReport } from "./report.ts";

const usage = `eutaxy — deterministic simulation checks and spec verdicts for Cloudflare Workers

Usage:
  eutaxy check <scenario.sim.ts> [options]
  eutaxy report [dir] [--prover <names>] [--seed <seed>] [--json]

check options:
  --wrangler <path>     wrangler config (default: wrangler.jsonc/json/toml beside the scenario)
  --seed <seed>         exploration seed (default: the scenario file name)
  --max-runs <n>        cap on exploration runs in addition to the scenario's time budget
  --budget-ms <n>       replace the scenario's time budget (with --max-runs, the run cap decides)
  --exhaustive          run every schedule within the bounds once (with partial-order reduction)
  --prover <names>      also run the PROVEN rung with these engines on the scenario's specs
                        (comma-separated; known: lean, smt)
  --json                print the versioned JSON report instead of text
  --out <path>          where to write the regression test on a violation
  --no-regression       do not write a regression test
  --expect-violation    write a regression test that asserts the violation (for corpora)
  --keep                keep the generated .eutaxy/ files

report runs every spec file (*.props.ts) under dir (default: the current directory)
through the TESTED rung, on inputs drawn from the parameter types with the seed
(default: report), and the PROVEN rung with --prover. No scenario runs, so nothing
is CHECKED.

Exit codes: 0 BOUNDED, 1 VIOLATED or a REFUTED or CONFLICT spec, 2 UNSUPPORTED, 3 error.
report: 0, or 1 for a REFUTED or CONFLICT spec, 3 error.
`;

export interface Io {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const { positionals, flags } = parseArgs(argv, [
    "json",
    "no-regression",
    "expect-violation",
    "keep",
    "help",
    "exhaustive",
  ]);
  const command = positionals[0];
  if (!command || command === "help" || flags["help"] === true) {
    io.stdout(usage);
    return command ? exitCodes.BOUNDED : exitCodes.error;
  }
  // A value flag given without one would otherwise read as absent: `--prover` alone must not quietly
  // skip the PROVEN rung.
  for (const k of ["wrangler", "seed", "max-runs", "budget-ms", "prover", "out"])
    if (flags[k] === true) {
      io.stderr(`--${k} needs a value\n`);
      return exitCodes.error;
    }
  const str = (k: string): string | undefined =>
    typeof flags[k] === "string" ? (flags[k] as string) : undefined;
  const provers = (str("prover") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (command === "report") {
    if (positionals.length > 2) {
      io.stderr(`report takes one directory\n\n${usage}`);
      return exitCodes.error;
    }
    const other = Object.keys(flags).find((k) => !["prover", "seed", "json"].includes(k));
    if (other !== undefined) {
      io.stderr(`report does not take --${other}\n`);
      return exitCodes.error;
    }
    const dir = positionals[1];
    return runReport({
      cwd: io.cwd,
      ...(dir === undefined ? {} : { dir }),
      ...(provers.length > 0 ? { provers } : {}),
      ...(str("seed") ? { seed: str("seed") as string } : {}),
      json: flags["json"] === true,
      stdout: io.stdout,
      stderr: io.stderr,
    });
  }
  if (command !== "check") {
    io.stderr(`unknown command ${command}\n\n${usage}`);
    return exitCodes.error;
  }
  const scenario = positionals[1];
  if (!scenario) {
    io.stderr(`check needs a scenario file\n\n${usage}`);
    return exitCodes.error;
  }
  const maxRunsText = str("max-runs");
  const maxRuns = maxRunsText === undefined ? undefined : Number(maxRunsText);
  if (maxRuns !== undefined && !(Number.isInteger(maxRuns) && maxRuns > 0)) {
    io.stderr(`--max-runs must be a positive integer, got ${JSON.stringify(maxRunsText)}\n`);
    return exitCodes.error;
  }
  const budgetText = str("budget-ms");
  const budgetMs = budgetText === undefined ? undefined : Number(budgetText);
  if (budgetMs !== undefined && !(Number.isInteger(budgetMs) && budgetMs > 0)) {
    io.stderr(`--budget-ms must be a positive integer, got ${JSON.stringify(budgetText)}\n`);
    return exitCodes.error;
  }
  return runCheck({
    scenario,
    cwd: io.cwd,
    ...(provers.length > 0 ? { provers } : {}),
    ...(str("wrangler") ? { wrangler: str("wrangler") as string } : {}),
    ...(str("seed") ? { seed: str("seed") as string } : {}),
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(budgetMs === undefined ? {} : { budgetMs }),
    exhaustive: flags["exhaustive"] === true,
    json: flags["json"] === true,
    ...(str("out") ? { out: str("out") as string } : {}),
    noRegression: flags["no-regression"] === true,
    expectViolation: flags["expect-violation"] === true,
    keep: flags["keep"] === true,
    stdout: io.stdout,
    stderr: io.stderr,
  });
}
