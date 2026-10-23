import { describe, expect, test } from "vitest";
import { defaultBounds, type ScenarioSpec, validateScenario } from "./scenario.ts";

const good: ScenarioSpec = {
  version: 1,
  name: "queue-duplicate-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "payments", messages: [] },
  setup: [{ kind: "d1", binding: "DB", schemaFile: "./schema.sql" }],
  externals: [],
  invariants: [
    { kind: "atMostOncePerKey", name: "once", effect: { target: "D1:DB" }, key: "args.params.0" },
  ],
  bounds: defaultBounds,
};

describe("validateScenario", () => {
  test("accepts a well-formed spec", () => {
    expect(validateScenario(good)).toEqual([]);
  });

  test("reports every problem at once", () => {
    const bad: ScenarioSpec = {
      ...good,
      name: "Bad Name",
      worker: { entry: "", config: "" },
      drive: { kind: "" },
      invariants: [
        { kind: "atMostOncePerKey", name: "dup", effect: { target: "x" }, key: "k" },
        { kind: "atMostOncePerKey", name: "dup", effect: { target: "x" }, key: "k" },
      ],
      externals: [
        { name: "pay", host: "a", guarantees: {} },
        { name: "pay", host: "b", guarantees: {} },
      ],
      bounds: {
        maxFaultsPerRun: -1,
        maxRedeliveries: 1.5,
        maxConcurrentInvocations: 0,
        budgetMs: 0,
      },
    };
    const errors = validateScenario(bad);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("name must be lowercase"),
        "worker.entry must not be empty",
        "worker.config must not be empty",
        "drive.kind must not be empty",
        'duplicate invariant name "dup"',
        'duplicate external "pay"',
        "bounds.maxFaultsPerRun must be a non-negative integer",
        "bounds.maxRedeliveries must be a non-negative integer",
        "bounds.maxConcurrentInvocations must be a positive integer",
        "bounds.budgetMs must be a positive integer",
      ]),
    );
  });

  test("validates externals", () => {
    const errors = validateScenario({
      ...good,
      externals: [
        { name: "", host: "", guarantees: {} },
        { name: "pay", host: "api.example", guarantees: {}, responses: [{ status: 42 }] },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "every external needs a name",
        'external "" needs a host',
        'external "pay" responses[0].status must be an HTTP status',
      ]),
    );
  });

  test("requires at least one invariant", () => {
    expect(validateScenario({ ...good, invariants: [] })).toContain(
      "at least one invariant is required",
    );
  });
});
