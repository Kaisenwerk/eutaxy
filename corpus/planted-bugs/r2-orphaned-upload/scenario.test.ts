/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { env } from "cloudflare:workers";
import { checkInvariants, renderText, replay, restrictSpec } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One upload would do, but the orphan's key is a seeded random id: dropping an
  // earlier upload shifts the ids drawn after it, and the shrinker keeps only a
  // smaller run that fails for the same keys. So at most both uploads stay.
  expect(verdict.keptEvents.length).toBeLessThanOrEqual(2);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a crash after the put leaves its object behind; the resend's own object is recorded", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["req-1"]);
  // Effects of req-1#1 in order: 0 the put, 1 the insert, 2 the response.
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      { invocation: "req-1#1", ordinal: 0, fault: "crash_after", target: "R2:FILES", op: "put" },
    ],
  });
  const ops = log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
  expect(ops).toEqual([
    "req-1#1 call R2:FILES put",
    "req-1#1 result R2:FILES put",
    "req-1#1 fault R2:FILES put",
    "req-1#2 call R2:FILES put",
    "req-1#2 result R2:FILES put",
    "req-1#2 call D1:DB run",
    "req-1#2 result D1:DB run",
    "req-1#2 call Http:/attachments response",
    "req-1#2 result Http:/attachments response",
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => [v.invariant, v.keys.length])).toEqual([
    ["every-object-recorded", 1],
  ]);
});

test("the row-first fix keeps every object recorded under the same faults", async () => {
  const fixed = {
    async fetch(request: Request, e: { FILES: R2Bucket; DB: D1Database }) {
      const upload = (await request.json()) as { messageId: string; name: string; text: string };
      const key = `attachments/${crypto.randomUUID()}`;
      await e.DB.prepare(
        "INSERT INTO attachments (message_id, name, object_key) VALUES (?1, ?2, ?3)",
      )
        .bind(upload.messageId, upload.name, key)
        .run();
      await e.FILES.put(key, upload.text, { customMetadata: { name: upload.name } });
      return Response.json({ key }, { status: 201 });
    },
  };
  // Without a status column the fix's pending rows break the reverse invariant, so check only the one the fix is for.
  const spec = {
    ...scenario,
    invariants: scenario.invariants.filter((i) => i.name === manifest.expect.invariant),
  };
  const platform = createCloudflarePlatform({ env, handler: fixed, schemas: { DB: schema } });
  const verdict = await check(spec, platform, { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
