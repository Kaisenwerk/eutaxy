/** Runs inside workerd: the proxied and raw runs agree on every answer and on what each store holds after the object's work. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { replay } from "eutaxy";
import { check, createCloudflarePlatform, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import * as worker from "./worker.ts";

const options = {
  env,
  handler: worker.default,
  schemas: { DB: schema },
  exports: worker,
  durableObjects: cloudflareTest,
};

test("proxied and raw runs agree on every answer and on the database, the bucket and the object's tables", async () => {
  const result = await runDifferential(scenario, options);
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.equal).toBe(true);
  expect(result.eutaxy.attempts.map((a) => [a.event, a.attempt, a.status, a.response])).toEqual([
    ["add-a", 1, "completed", 201],
    ["add-b", 1, "completed", 201],
    ["add-c", 1, "completed", 413],
    ["read-a", 1, "completed", 200],
  ]);
  expect(result.eutaxy.state["DB"]?.["catalogue"]).toEqual([
    { name: "a.txt", size: 5 },
    { name: "b.txt", size: 12 },
  ]);
  const objects = result.eutaxy.state["BUCKET"]?.["objects"] as
    | { key: string; text?: string }[]
    | undefined;
  expect(objects?.map((o) => [o.key, o.text])).toEqual([
    ["a.txt", "alpha"],
    ["b.txt", "bravo, again"],
  ]);
  expect(result.eutaxy.state["LIBRARY"]?.["lib/files"]).toEqual([
    { name: "a.txt", size: 5, status: "listed" },
    { name: "b.txt", size: 12, status: "listed" },
  ]);
});

test("under the proxies every statement and bucket operation of the object is recorded, and nothing is unsupported", async () => {
  const platform = createCloudflarePlatform(options);
  const log = await replay(scenario, platform, { seed: 0, faults: [] });
  const calls = log.entries
    .filter((e) => e.kind === "call" && /^(D1|R2):/.test(e.target))
    .map((e) => `${e.invocation} ${e.target} ${e.op}`);
  expect(calls).toEqual([
    // The first call constructs the object, whose constructor loads the limit.
    "add-a#1 D1:DB first",
    "add-a#1 R2:BUCKET put",
    // The batch is issued before the answer and not awaited: recorded where it was issued.
    "add-a#1 D1:DB batch",
    "add-b#1 R2:BUCKET put",
    "add-b#1 D1:DB batch",
    "read-a#1 R2:BUCKET get",
    "read-a#1 D1:DB first",
  ]);
  const verdict = await check(scenario, platform, { seed: "differential", budgetMs: 30_000 });
  expect(verdict.kind).toBe("BOUNDED");
});
