/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform, http } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { events } from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler, { chatWebhook } from "./worker.ts";

const platformWith = (h: typeof handler) =>
  createCloudflarePlatform({ env, handler: h, schemas: { DB: schema } });

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platformWith(handler), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // Every resend was answered 503: the lease was still held.
  const statuses = verdict.trace.entries
    .filter((e) => e.kind === "result" && e.op === "response")
    .map((e) => (e.payload as { result: { status: number } }).result.status);
  expect(statuses.slice(1)).toEqual([503, 503, 503, 503]);
  expect(verdict.trace.entries.some((e) => e.op === "gave_up")).toBe(true);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a lease shorter than the resend window holds with the caller's real delays", async () => {
  const verdict = await check(scenario, platformWith(chatWebhook(60_000)), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("the same short lease is lost again when resends come without delays", async () => {
  const immediate = http(events.requests, { retries: 4 });
  const verdict = await check(
    { ...scenario, drive: immediate },
    platformWith(chatWebhook(60_000)),
    {
      seed: "corpus",
    },
  );
  expect(verdict.kind, renderText(verdict)).toBe("VIOLATED");
});
