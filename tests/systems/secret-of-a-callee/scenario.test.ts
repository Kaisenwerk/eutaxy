/**
 * A var and a secret from the scenario, run through the command: a callee
 * that refuses to work without its secret, and a front Worker whose var the
 * scenario replaces. What each Worker read shows on the console.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

/** `eutaxy check --console` on one of this directory's scenarios, one run: its status and its two streams. */
function check(scenario: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [
        bin,
        "check",
        `tests/systems/secret-of-a-callee/${scenario}.sim.ts`,
        "--seed",
        "gate",
        "--max-runs",
        "1",
        "--no-regression",
        "--budget-ms",
        "30000",
        "--console",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", fail);
    child.once("close", (status) => done({ status: status ?? 1, stdout, stderr }));
  });
}

test("the scenario's secret reaches the callee and its var replaces the config's; without them the callee refuses", async () => {
  const [given, missing] = await Promise.all([check("given"), check("missing")]);

  expect(given.status, given.stderr).toBe(0);
  expect(given.stdout).toMatch(/^BOUNDED {2}secret-of-a-callee {2}/);
  // The callee read the secret (eight characters: "test-key") and the front Worker the scenario's region.
  expect(given.stderr).toContain("notes: n-1 signed with a key of 8 characters");
  expect(given.stderr).toContain("front: region eu");
  // A var the callee's own wrangler config gives is replaced too.
  expect(given.stderr).toContain("notes: tier gold");
  expect(given.stderr).not.toContain("API_KEY is not set");
  // The secret's value is nowhere in what the command printed.
  expect(`${given.stdout}${given.stderr}`).not.toContain("test-key");

  // The same Workers with nothing given: no secret for the callee, the config's own region.
  expect(missing.status, missing.stderr).toBe(0);
  expect(missing.stderr).toContain("notes: API_KEY is not set");
  expect(missing.stderr).toContain("front: region from-the-config");
  expect(missing.stderr).toContain("notes: tier from-the-config");
  expect(missing.stderr).not.toContain("signed with a key");
}, 240_000);

test("a Worker with no callee and no service binding gets them too, and so does its Durable Object", async () => {
  const solo = await check("solo");
  expect(solo.status, solo.stderr).toBe(0);
  expect(solo.stdout).toMatch(/^BOUNDED {2}secret-of-a-worker {2}/);
  expect(solo.stderr).toContain("solo: region eu");
  // The object reads the secret off the env the runtime constructed it with.
  expect(solo.stderr).toContain("object: k-1 kept with a key of 8 characters");
  expect(`${solo.stdout}${solo.stderr}`).not.toContain("test-key");
}, 240_000);
