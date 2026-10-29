import type { ScenarioSpec } from "@eutaxy/core";
import { readSpecs } from "@eutaxy/prover/reader";
import { forall } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { globKey } from "./keys.ts";
import { checkInWorkerd, schemasFor, selectSpecModules } from "./workerd.ts";

const base: ScenarioSpec = {
  version: 1,
  name: "s",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: [] },
  setup: [{ kind: "d1", binding: "DB", schemaFile: "./schema.sql" }],
  externals: [],
  invariants: [],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 1000 },
};

const domainSpecs = readSpecs({
  module: "export function f(x: number) { return x; }",
  spec: 'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const positive = forall(f, { when: (x) => x > 0, ensures: (x) => f(x) > 0 });',
  modulePath: "/virtual/domain.ts",
});

describe("globKey", () => {
  test("is the scenario-relative path seen from .eutaxy/", () => {
    expect(globKey("./schema.sql")).toBe("../schema.sql");
    expect(globKey("././core/domain.ts")).toBe("../core/domain.ts");
    expect(globKey("worker.ts")).toBe("../worker.ts");
  });
});

describe("schemasFor", () => {
  test("maps each D1 binding to its schema file's text", () => {
    expect(schemasFor(base, { "../schema.sql": "CREATE TABLE t (x);" })).toEqual({
      DB: "CREATE TABLE t (x);",
    });
  });

  test("names a schema file that is not next to the scenario", () => {
    expect(() => schemasFor(base, {})).toThrow(/schema file \.\/schema\.sql not found/);
  });
});

describe("selectSpecModules", () => {
  const f = (x: number) => x;
  const domain = { f, decide: () => true };
  const loaders = {
    "./domain.ts": {
      specs: domainSpecs,
      load: async () => ({ positive: forall(f, { when: (x) => x > 0, ensures: (x) => f(x) > 0 }) }),
    },
  };

  test("observes a listed module's functions with specs and the decisions refines names", async () => {
    const scenario: ScenarioSpec = {
      ...base,
      specs: ["./domain.ts"],
      invariants: [
        { kind: "refines", name: "r", decision: "decide", effect: { target: "D1:DB" } },
        { kind: "refines", name: "n", decision: "missing", effect: { target: "D1:DB" } },
      ],
    };
    const { selected, specErrors } = await selectSpecModules(
      scenario,
      { "../domain.ts": async () => domain },
      loaders,
    );
    expect(specErrors).toEqual([]);
    expect(selected.map((m) => [m.path, m.key, m.names])).toEqual([
      ["./domain.ts", "./domain.ts", ["f", "decide"]],
    ]);
  });

  test("reports a missing module, a spec file's errors and a name observed twice", async () => {
    const broken = { functions: [], errors: [{ line: 3, message: "bad spec" }] };
    const scenario: ScenarioSpec = {
      ...base,
      specs: ["./nope.ts", "./domain.ts", "./again.ts", "./broken.ts"],
    };
    const { specErrors } = await selectSpecModules(
      scenario,
      {
        "../domain.ts": async () => domain,
        "../again.ts": async () => domain,
        "../broken.ts": async () => ({ g: () => 0 }),
      },
      {
        ...loaders,
        "./again.ts": loaders["./domain.ts"],
        "./broken.ts": { specs: broken, load: async () => ({}) },
      },
    );
    expect(specErrors.map((e) => [e.module, e.message.split(";")[0]])).toEqual([
      ["./nope.ts", "no such module next to the scenario"],
      ["./broken.props.ts", "bad spec"],
      ["./again.ts", "f is observed in both ./domain.ts and ./again.ts"],
    ]);
  });
});

describe("checkInWorkerd", () => {
  const scenario: ScenarioSpec = {
    ...base,
    setup: [],
    drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { n: 1 } }] },
  };
  const worker = {
    default: {
      queue(batch: { readonly messages: readonly { ack(): void }[] }) {
        for (const m of batch.messages) m.ack();
      },
    },
  };
  const input = {
    scenario,
    env: {},
    durableObjects: {} as never,
    sqlFiles: {},
    modules: { "../worker.ts": async () => worker },
    specEntries: {},
    seed: "t",
    maxRuns: 2,
  };

  test("runs the check and returns the report with what was observed", async () => {
    const transport = await checkInWorkerd(input);
    expect((transport.report as { verdict: { kind: string } }).verdict.kind).toBe("BOUNDED");
    expect(transport.worker).toEqual(scenario.worker);
    expect(transport.observed).toEqual([]);
    expect(transport.specErrors).toBeUndefined();
  });

  test("returns the spec errors instead of a report, without running the check", async () => {
    let loaded = 0;
    const transport = await checkInWorkerd({
      ...input,
      scenario: { ...scenario, specs: ["./missing.ts"] },
      modules: {
        "../worker.ts": async () => {
          loaded++;
          return worker;
        },
      },
    });
    expect(transport.report).toBeNull();
    expect(transport.specErrors?.map((e) => e.module)).toEqual(["./missing.ts"]);
    expect(loaded).toBe(1);
  });

  test("names a worker entry that is not next to the scenario", async () => {
    await expect(checkInWorkerd({ ...input, modules: {} })).rejects.toThrow(
      /worker entry \.\/worker\.ts not found/,
    );
  });
});
