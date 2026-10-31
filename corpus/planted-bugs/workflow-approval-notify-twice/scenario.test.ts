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
const fixed = { ...scenario, setup: [workflow("APPROVALS", "FixedApprovalFlow")] };
const { ECHO } = env as unknown as { readonly ECHO: Workflow };

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  const notifications = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "Fetch:notify" && e.op === "POST",
  );
  expect(notifications).toHaveLength(2);
  // The wait received the event once; the replay returned the stored event.
  const received = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "event");
  expect(received).toHaveLength(1);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    exports: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed Workflow notifies in a step, which a replay does not run again", async () => {
  const verdict = await check(fixed, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("the model agrees with the local Workflows engine on a waiting instance", async () => {
  // The local engine: an instance that waits for two events, sent through the real binding.
  await using real = await introspectWorkflowInstance(ECHO, "echo-1");
  const instance = await ECHO.create({ id: "echo-1", params: { documentId: "echo-1" } });
  // Events are buffered until the instance's waits reach them (Workflows, Events and parameters).
  await instance.sendEvent({ type: "decided", payload: { by: "alice", approved: true } });
  await instance.sendEvent({ type: "noted", payload: { note: "looks good" } });
  await real.waitForStatus("complete");
  const engineOutput = await real.getOutput();

  // The same instance under the model, the events sent by the Worker's handler.
  const echo = {
    ...scenario,
    name: "workflow-echo",
    setup: [workflow("ECHO", "EchoFlow")],
    drive: http(
      [
        { path: "/approvals", body: { documentId: "echo-1" } },
        { path: "/decisions", body: { documentId: "echo-1", by: "alice", approved: true } },
      ],
      { retries: 0 },
    ),
    invariants: [],
  };
  const modelPlatform = createCloudflarePlatform({
    env,
    handler: {
      async fetch(request: Request, e: unknown) {
        // Route the second request's event through ECHO, and add the note the flow also waits for.
        const flows = e as { ECHO: Workflow };
        const url = new URL(request.url);
        const body = (await request.json()) as { documentId: string; by?: string };
        if (url.pathname === "/approvals") {
          await flows.ECHO.create({ id: body.documentId, params: { documentId: body.documentId } });
          return new Response("started");
        }
        const i = await flows.ECHO.get(body.documentId);
        await i.sendEvent({ type: "decided", payload: { by: body.by, approved: true } });
        await i.sendEvent({ type: "noted", payload: { note: "looks good" } });
        return new Response("sent");
      },
    },
    schemas: {},
    exports: worker,
  });
  const log = await replay(echo, modelPlatform, { seed: 0, faults: [] });
  const snapshot = log.entries.findLast(
    (e) => e.kind === "snapshot" && e.target === "Workflow:ECHO",
  );
  if (!snapshot) throw new Error("no Workflow snapshot");
  const [modelInstance] = (
    snapshot.payload as { tables: { instances: { status: string; output: unknown }[] } }
  ).tables.instances;
  expect(modelInstance?.status).toBe("complete");
  expect(modelInstance?.output).toEqual(engineOutput);
  expect(engineOutput).toEqual({ documentId: "echo-1", by: "alice", note: "looks good" });
});
