/**
 * A scripted Durable Object namespace of a called Worker, run through the
 * command: the front Worker calls the jobs Worker, whose pool object runs
 * each job on a machine, an object of a namespace of the jobs Worker's
 * that the scenario scripts under the Worker's name (`jobs/MACHINE`).
 * `eutaxy check` builds the isolate from both wrangler configs; the
 * machine's class is in it and is never constructed (its constructor
 * throws).
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");
const dir = "tests/systems/scripted-object-of-a-callee";

/**
 * The command in a process group of its own, ended when it has not finished within `ms`: a check
 * that hangs fails its test, not the suite, and leaves no runtime behind.
 */
function eutaxyWithin(
  args: readonly string[],
  ms: number,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, ...args, "--budget-ms", "30000"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let ended = false;
    const timer = setTimeout(() => {
      ended = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, ms);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", fail);
    child.once("close", (status) => {
      clearTimeout(timer);
      done({
        status: ended ? -1 : (status ?? 1),
        stdout,
        stderr: ended ? `${stderr}\n(ended after ${ms} ms without finishing)` : stderr,
      });
    });
  });
}

interface Report {
  readonly verdict: {
    readonly kind: string;
    readonly reason?: string;
    readonly assumptions: readonly string[];
    readonly reached: {
      readonly runs: number;
      readonly effectPoints: number;
      readonly exhaustive?: { readonly complete: boolean };
    };
  };
}

/**
 * Run one of the entry's scenarios, up to `runs` seeded runs or, given "exhaustive", every schedule
 * within its bounds; a check that does not end fails here, within two minutes.
 */
async function check(
  scenario: string,
  runs: number | "exhaustive",
): Promise<{ status: number; report: Report }> {
  const r = await eutaxyWithin(
    [
      "check",
      `${dir}/${scenario}.sim.ts`,
      "--json",
      "--seed",
      "gate",
      ...(runs === "exhaustive"
        ? ["--exhaustive", "--max-runs", "1000"]
        : ["--max-runs", String(runs)]),
      "--no-regression",
    ],
    120_000,
  );
  expect([0, 1, 2], `${r.stdout}\n${r.stderr}`).toContain(r.status);
  return { status: r.status, report: JSON.parse(r.stdout) as Report };
}

test("with nothing going wrong every job ends running, in every order of two in flight: the machines answered from the script", async () => {
  const { status, report } = await check("scenario", "exhaustive");
  expect(report.verdict.kind, report.verdict.reason).toBe("BOUNDED");
  expect(status).toBe(0);
  expect(report.verdict.reached.exhaustive?.complete).toBe(true);
  expect(report.verdict.assumptions.join("\n")).toContain(
    "a Durable Object namespace with a scriptedObject() setup is scripted",
  );
}, 240_000);

test("one fault a run, one at a time: every placement holds, exhaustively", async () => {
  const { status, report } = await check("sequential", "exhaustive");
  expect(report.verdict.kind, report.verdict.reason).toBe("BOUNDED");
  expect(status).toBe(0);
  expect(report.verdict.reached.exhaustive?.complete).toBe(true);
}, 240_000);

test("one fault a run, two in flight, 50 seeded runs: BOUNDED, nothing unsupported", async () => {
  const { status, report } = await check("faulted", 50);
  expect(report.verdict.kind, report.verdict.reason).toBe("BOUNDED");
  expect(status).toBe(0);
}, 240_000);
