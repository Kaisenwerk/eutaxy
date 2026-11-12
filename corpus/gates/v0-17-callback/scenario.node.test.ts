/**
 * The second part of the v0.17 gate, run through the command: two Workers'
 * real code, where the Worker that was called calls back. The turns
 * Worker's object, in work after its answer, asks a scripted model and then
 * calls the front Worker, the scenario's own, whose handler wakes the
 * Workflow that was waiting. `eutaxy check` builds the isolate from both
 * wrangler configs and takes the callee step that names the scenario's own
 * Worker for what it is.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");
const dir = "corpus/gates/v0-17-callback";

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
    readonly reached: { readonly runs: number; readonly effectPoints: number };
    readonly violation?: { readonly invariant: string };
    readonly schedule?: { readonly faults: readonly { readonly invocation: string }[] };
  };
}

/** Run one of the entry's scenarios; a check that does not end fails here, within two minutes. */
async function check(scenario: string, runs: number): Promise<{ status: number; report: Report }> {
  const r = await eutaxyWithin(
    [
      "check",
      `${dir}/${scenario}.sim.ts`,
      "--json",
      "--seed",
      "gate",
      "--max-runs",
      String(runs),
      "--no-regression",
    ],
    120_000,
  );
  expect([0, 1, 2], `${r.stdout}\n${r.stderr}`).toContain(r.status);
  return { status: r.status, report: JSON.parse(r.stdout) as Report };
}

test("with nothing going wrong the callback wakes the Workflow: every reply comes by the event, two in flight", async () => {
  const { status, report } = await check("requests", 60);
  expect(report.verdict.kind, report.verdict.reason).toBe("BOUNDED");
  expect(status).toBe(0);
  expect(report.verdict.reached.effectPoints).toBeGreaterThan(500);
  expect(report.verdict.assumptions.join("\n")).toContain(
    "callee() setup runs that Worker's real code",
  );
}, 240_000);

test.each([
  ["faulted", "two in flight"],
  ["sequential", "one at a time"],
])(
  "one fault a run, anywhere (%s: %s): BOUNDED, nothing unsupported",
  async (scenario) => {
    const { status, report } = await check(scenario, 100);
    expect(report.verdict.kind, report.verdict.reason).toBe("BOUNDED");
    expect(status).toBe(0);
  },
  240_000,
);

test("a front Worker that records every notice it is sent is caught: a notice whose answer was lost is recorded twice", async () => {
  const { status, report } = await check("planted", 100);
  expect(report.verdict.kind, report.verdict.reason).toBe("VIOLATED");
  expect(status).toBe(1);
  expect(report.verdict.violation?.invariant).toBe("one-notice-per-request");
  // The fault is inside the call back: an effect of the front Worker's invocation hosted by the
  // object's own call, in the object's work after its answer.
  expect(report.verdict.schedule?.faults).toHaveLength(1);
  expect(report.verdict.schedule?.faults[0]?.invocation).toMatch(
    /^DO:turns\/TURN\/req-\d\/after\/turns\/FRONT\.turnEnded/,
  );
}, 240_000);
