/** Runs inside workerd: the proxied and raw runs agree on every response and on the bucket's objects. */

import { env } from "cloudflare:workers";
import { replay } from "eutaxy";
import { createCloudflarePlatform, expectHolds, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import handler, { type Env } from "./worker.ts";

test("proxies agree with the raw bucket", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: {} });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.equal).toBe(true);
  expect(result.eutaxy.attempts.map((a) => a.response)).toEqual([200, 200, 200]);
  const objects = result.eutaxy.state["FILES"]?.["objects"] as
    | { key: string; text?: string; customMetadata: Record<string, string> }[]
    | undefined;
  expect(objects?.map((o) => [o.key, o.text, o.customMetadata])).toEqual([
    ["docs/a", "first, again\nreviewed", { id: "a", reviewed: "yes" }],
    ["docs/b", "second\nreviewed", { id: "b", reviewed: "yes" }],
    ["docs/readme", "seeded", { id: "readme" }],
  ]);
});

test("both invariants hold under faults at every call", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: {} });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40 });
});

test("the trace and the versions the Worker sees repeat, though the bucket's own do not", async () => {
  const seen: unknown[] = [];
  const watching = {
    async fetch(request: Request, e: Env) {
      const response = await handler.fetch(request, e);
      const o = await e.FILES.head("docs/a");
      seen.push(o && [o.version, o.uploaded.getTime()]);
      return response;
    },
  };
  const platform = createCloudflarePlatform({ env, handler: watching, schemas: {} });
  const realVersion = async () => (await (env as unknown as Env).FILES.head("docs/a"))?.version;
  const first = await replay(scenario, platform, { seed: 1, faults: [] });
  const firstSeen = seen.splice(0);
  const firstReal = await realVersion();
  const second = await replay(scenario, platform, { seed: 1, faults: [] });
  expect(await realVersion()).not.toBe(firstReal);
  expect(seen).toEqual(firstSeen);
  expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
});
