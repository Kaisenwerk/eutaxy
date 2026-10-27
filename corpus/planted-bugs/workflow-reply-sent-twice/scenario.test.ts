/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText, replay } from "eutaxy";
import {
  check,
  cloudflareRegressionTest,
  createCloudflarePlatform,
  http,
  workflow,
} from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler: worker.default, schemas: {}, exports: worker });
const fixed = { ...scenario, setup: [workflow("TURNS", "FixedChatTurn")] };
const { COUNTING } = env as unknown as { readonly COUNTING: Workflow };

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // The reply step ran twice: once before the engine restarted, once after.
  const replies = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "Fetch:chat" && e.op === "POST",
  );
  expect(replies).toHaveLength(2);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    workflows: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed Workflow's idempotency key makes the repeated step harmless", async () => {
  const verdict = await check(fixed, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("exhaustive exploration finds it too, and every schedule of the fix holds", async () => {
  const buggy = await check(scenario, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(buggy.kind, renderText(buggy)).toBe("VIOLATED");
  const holds = await check(fixed, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(holds.kind, renderText(holds)).toBe("BOUNDED");
  expect(holds.reached.exhaustive?.complete).toBe(true);
});

test("the model agrees with the local Workflows engine on a fault-free run", async () => {
  // The local engine, with its sleeps and retry delays switched off.
  await using real = await introspectWorkflowInstance(COUNTING, "count-1");
  await real.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  await COUNTING.create({ id: "count-1", params: { n: 3 } });
  await real.waitForStatus("complete");
  const engineOutput = await real.getOutput();

  // The same instance under the model, started by the Worker.
  const counting = {
    ...scenario,
    name: "workflow-counting",
    setup: [workflow("COUNTING", "CountingFlow")],
    drive: http([{ path: "/counting" }], { retries: 0 }),
    invariants: [],
  };
  const log = await replay(counting, platform(), { seed: 0, faults: [] });
  const snapshot = log.entries.findLast(
    (e) => e.kind === "snapshot" && e.target === "Workflow:COUNTING",
  );
  if (!snapshot) throw new Error("no Workflow snapshot");
  const [instance] = (
    snapshot.payload as { tables: { instances: { status: string; output: unknown }[] } }
  ).tables.instances;
  expect(instance?.status).toBe("complete");
  expect(instance?.output).toEqual(engineOutput);
  expect(engineOutput).toEqual({ counts: [1, 2, 3], attempt: 2, id: "count-1", payload: { n: 3 } });
});

test("the model's errors are the local binding's", async () => {
  await using _ = await introspectWorkflowInstance(COUNTING, "dup-1");
  await COUNTING.create({ id: "dup-1", params: { n: 0 } });
  await expect(COUNTING.create({ id: "dup-1", params: { n: 0 } })).rejects.toThrow(
    '(instance.already_exists) Workflow instance with id "dup-1" already exists',
  );
  await expect(COUNTING.get("no-such-instance")).rejects.toThrow("instance.not_found");
});
