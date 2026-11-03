/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

const platformFor = (bindings: object) =>
  createCloudflarePlatform({ env: bindings, handler, schemas: {}, durableObjects: cloudflareTest });

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platformFor(env), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  expect(verdict.schedule.faults).toEqual([]);
  const order = verdict.trace.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
  // Both connections opened through the Worker and were handed to the room.
  expect(order).toContain("conn-1#1 result WebSocket:conn-1 open");
  expect(order).toContain("conn-2#1 result WebSocket:conn-2 open");
  // The second message was sent before the first one's moderation came back: the race.
  const sends = order.filter(
    (l) => l.endsWith("call WebSocket:conn-1 send") || l.endsWith("call WebSocket:conn-2 send"),
  );
  expect(sends).toHaveLength(2);
  const firstModeration = order.findIndex((l) => l.includes("result Fetch:moderation POST"));
  expect(order.indexOf(sends[1] as string)).toBeLessThan(firstModeration);
  // What the room sent back reached each client: the SDK's state frames and the room's own count.
  const received = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "message");
  const counts = received
    .map(
      (e) =>
        (e.payload as { args: { connection: string; data: { type?: string; count?: number } } })
          .args,
    )
    .filter((a) => a.data.type === "count")
    .map((a) => `${a.connection}:${a.data.count}`);
  expect(counts).toEqual(["conn-1:1", "conn-1:1", "conn-2:1", "conn-2:1"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed room takes the count before moderation and holds with two in flight", async () => {
  const bindings = { ROOM: (env as unknown as { FIXED_ROOM: unknown }).FIXED_ROOM };
  const verdict = await check(scenario, platformFor(bindings), {
    seed: "corpus",
    budgetMs: 30_000,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
