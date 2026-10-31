/**
 * The binding records: each kind answers for its own env value, reports a
 * binding the scenario did not set up, and the platform iterates the records
 * in setup order, knowing none of them by name.
 */
import type { EffectLog, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { d1Binding, durableObjectBinding, r2Binding, workflowBinding } from "./bindings.ts";
import type { ProxyContext } from "./d1.ts";
import { FakeR2 } from "./fake-r2.ts";
import { createCloudflarePlatform } from "./platform.ts";
import { durableObject, queue, r2Bucket, workflow } from "./scenario.ts";

/** The fake bucket as the real binding's type; the records only call what it implements. */
const bucket = (): R2Bucket => new FakeR2() as unknown as R2Bucket;

/** A context whose hooks only collect what the records report. */
function context(): { ctx: ProxyContext; reported: string[] } {
  const reported: string[] = [];
  const hooks = { unsupported: (reason: string) => reported.push(reason) } as unknown as RunHooks;
  return { ctx: { hooks, currentInvocation: () => "i" }, reported };
}

describe("each record answers for its own kind", () => {
  test("the records tell their bindings apart and reject everything else", () => {
    const { ctx } = context();
    const records = [
      d1Binding({}),
      durableObjectBinding({ ctx, helpers: undefined, real: () => undefined }),
      r2Binding(),
      workflowBinding({ exports: undefined, env: () => ({}) }),
    ];
    expect(records.map((r) => [r.kind, r.target])).toEqual([
      ["d1", "D1"],
      ["durable_object", "DO"],
      ["r2", "R2"],
      ["workflow", "Workflow"],
    ]);
    const sample = bucket();
    expect(records.map((r) => r.is(sample))).toEqual([false, false, true, false]);
    for (const r of records) {
      expect(r.is({})).toBe(false);
      expect(r.is({ fetch() {} })).toBe(false);
    }
  });

  test("a D1 record needs a schema and a D1 binding to reset, and snapshots nothing else", async () => {
    const d1 = d1Binding({ DB: "CREATE TABLE t (id TEXT)" });
    const step = { kind: "d1", binding: "OTHER", schemaFile: "x.sql" } as const;
    await expect(d1.reset(step, {})).rejects.toThrow("no schema provided for D1 binding OTHER");
    await expect(d1.reset({ ...step, binding: "DB" }, {})).rejects.toThrow(
      "env.DB is not a D1 binding",
    );
    expect(await d1.snapshot({ ...step, binding: "DB" }, bucket(), () => {})).toBeNull();
  });

  test("an R2 record reports a bucket touched without a setup step, each time, until it is set up", async () => {
    const r2 = r2Binding();
    const { ctx, reported } = context();
    const real = bucket();
    const first = r2.proxy("BUCKET", real, ctx);
    const second = r2.proxy("BUCKET", real, ctx);
    expect(second).toBe(first);
    expect(reported).toHaveLength(2);
    await r2.reset(r2Bucket("BUCKET", { "a.txt": "a" }), real);
    r2.proxy("BUCKET", real, ctx);
    expect(reported).toHaveLength(2);
    expect(await r2.snapshot(r2Bucket("BUCKET"), real, () => {})).toEqual({
      objects: [expect.objectContaining({ key: "a.txt", text: "a" })],
    });
    expect(await r2.snapshot(r2Bucket("BUCKET"), {}, () => {})).toBeNull();
    await expect(r2.reset(r2Bucket("BUCKET"), {})).rejects.toThrow(
      "env.BUCKET is not an R2 bucket",
    );
    // The next run's setup starts over: the bucket is unknown again until reset.
    r2.clear();
    r2.proxy("BUCKET", real, ctx);
    expect(reported).toHaveLength(3);
  });

  test("a Workflow record reports a binding without a setup step and never caches that proxy", async () => {
    const wf = workflowBinding({ exports: undefined, env: () => ({}) });
    const { ctx, reported } = context();
    const binding = { create() {}, createBatch() {}, get() {} };
    expect(wf.is(binding)).toBe(true);
    expect(wf.proxy("FLOW", binding, ctx)).not.toBe(wf.proxy("FLOW", binding, ctx));
    expect(reported).toEqual([
      "Workflow binding FLOW needs a workflow() setup step naming its class",
      "Workflow binding FLOW needs a workflow() setup step naming its class",
    ]);
    await wf.reset(workflow("FLOW", "Flow"), binding);
    expect(wf.proxy("FLOW", binding, ctx)).toBe(wf.proxy("FLOW", binding, ctx));
    expect(reported).toHaveLength(2);
    expect(await wf.snapshot(workflow("FLOW", "Flow"), binding, () => {})).toEqual({
      instances: [],
    });
  });

  test("a Durable Object record needs a namespace and the test helpers to reset", async () => {
    const { ctx } = context();
    const namespace = { idFromName() {}, get() {} };
    const dobj = durableObjectBinding({ ctx, helpers: undefined, real: () => namespace });
    expect(dobj.is(namespace)).toBe(true);
    await expect(dobj.reset(durableObject("OBJ", {}), {})).rejects.toThrow(
      "env.OBJ is not a Durable Object namespace",
    );
    await expect(dobj.reset(durableObject("OBJ", {}), namespace)).rejects.toThrow(
      "Durable Object setup needs the Cloudflare test helpers",
    );
  });
});

describe("the platform iterates the records", () => {
  const bounds = {
    maxFaultsPerRun: 0,
    maxRedeliveries: 0,
    maxConcurrentInvocations: 1,
    budgetMs: 10_000,
  };

  async function logOf(setup: ScenarioSpec["setup"], env: object): Promise<EffectLog> {
    const spec: ScenarioSpec = {
      version: 1,
      name: "records",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: queue("q", [{ body: 1 }]),
      setup,
      externals: [],
      invariants: [],
      bounds,
    };
    const platform = createCloudflarePlatform({ env, handler: { queue: () => {} }, schemas: {} });
    const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    return runOnce(spec, platform, run);
  }

  test("snapshots come in setup order, each under its record's target", async () => {
    const env = { B: bucket(), A: bucket() };
    const log = await logOf([r2Bucket("B", { b: "1" }), r2Bucket("A")], env);
    const snapshots = log.entries.filter((e) => e.kind === "snapshot").map((e) => e.target);
    expect(snapshots).toEqual(["R2:B", "R2:A"]);
  });

  test("a setup step of a kind no record owns is left to the scenario's validation", async () => {
    const log = await logOf([{ kind: "kv", binding: "KV" }], { KV: {} });
    expect(log.entries.filter((e) => e.kind === "snapshot")).toEqual([]);
  });
});
