/**
 * Runs inside workerd: a check that ends UNSUPPORTED after a fault carries the run that got there as
 * a pinned schedule, its fault at the call it hit (target, op, arguments and that call's number),
 * and the test `eutaxy check` writes for it (`regression.test.ts`, committed as written) replays
 * that run to the same reason.
 */

import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareUnsupportedTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import committed from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test("the check is UNSUPPORTED after a fault, and the test it writes is the one committed", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("UNSUPPORTED");
  if (verdict.kind !== "UNSUPPORTED") return;
  expect(verdict.cause).toBe("unsupported_api");
  expect(verdict.reason).toContain("fetch to undeclared host audit.example");
  // The fault is addressed by the call it hit, not by the invocation and position the schedule names.
  expect(verdict.schedule?.faults.map((f) => `${f.invocation} ${f.ordinal}`)).toEqual([
    "msg-1#1 1",
  ]);
  expect(verdict.replay?.faults).toEqual([
    {
      at: {
        target: "D1:DB",
        op: "run",
        where: { args: { sql: "INSERT INTO orders (order_id) VALUES (?1)", params: ["o-1"] } },
      },
      call: 1,
      fault: "ambiguous",
    },
  ]);
  const emitted = cloudflareUnsupportedTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
  });
  expect(emitted).toBe(committed);
});
