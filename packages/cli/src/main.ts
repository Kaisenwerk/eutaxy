import { parseArgs } from "./args.ts";
import { exitCodes, runCheck } from "./check.ts";

const usage = `eutaxy — deterministic simulation checks for Cloudflare Workers

Usage:
  eutaxy check <scenario.sim.ts> [options]

Options:
  --wrangler <path>     wrangler config (default: wrangler.jsonc/json/toml beside the scenario)
  --seed <seed>         exploration seed (default: the scenario file name)
  --max-runs <n>        cap on exploration runs in addition to the scenario's time budget
  --exhaustive          run every schedule within the bounds once (with partial-order reduction)
  --json                print the versioned JSON report instead of text
  --out <path>          where to write the regression test on a violation
  --no-regression       do not write a regression test
  --expect-violation    write a regression test that asserts the violation (for corpora)
  --keep                keep the generated .eutaxy/ files

Exit codes: 0 BOUNDED, 1 VIOLATED or a REFUTED spec, 2 UNSUPPORTED, 3 error.
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
  if (command !== "check") {
    io.stderr(`unknown command ${command}\n\n${usage}`);
    return exitCodes.error;
  }
  const scenario = positionals[1];
  if (!scenario) {
    io.stderr(`check needs a scenario file\n\n${usage}`);
    return exitCodes.error;
  }
  const str = (k: string): string | undefined =>
    typeof flags[k] === "string" ? (flags[k] as string) : undefined;
  const maxRunsText = str("max-runs");
  const maxRuns = maxRunsText === undefined ? undefined : Number(maxRunsText);
  if (maxRuns !== undefined && !(Number.isInteger(maxRuns) && maxRuns > 0)) {
    io.stderr(`--max-runs must be a positive integer, got ${JSON.stringify(maxRunsText)}\n`);
    return exitCodes.error;
  }
  return runCheck({
    scenario,
    cwd: io.cwd,
    ...(str("wrangler") ? { wrangler: str("wrangler") as string } : {}),
    ...(str("seed") ? { seed: str("seed") as string } : {}),
    ...(maxRuns === undefined ? {} : { maxRuns }),
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
