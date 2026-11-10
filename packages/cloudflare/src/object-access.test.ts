/**
 * The guard on an object's own service bindings: the runtime hands an object
 * the Worker's real env, so a call through a service binding there is not
 * the scenario's script or callee answering, and the run says so.
 */
import type { RunHooks } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { guardEnv } from "./object-access.ts";

/** Hooks that only collect the reasons a run was called unsupported for. */
function collecting(): { hooks: RunHooks; reasons: string[] } {
  const reasons: string[] = [];
  return { hooks: { unsupported: (r: string) => void reasons.push(r) } as RunHooks, reasons };
}

/** A service binding as a test double has it: fetch and connect, none of the other kinds' marks. */
const peer = () => ({
  fetch: async () => new Response("the real peer"),
  connect: () => undefined,
  complete: async () => "the real peer",
});

describe("guardEnv", () => {
  test("a call on a service binding through the object's env ends the run UNSUPPORTED, naming both", async () => {
    const { hooks, reasons } = collecting();
    const db = { prepare: () => "statement" };
    const instance = { env: { PEER: peer(), DB: db, LIMIT: 3 } as Record<string, unknown> };
    guardEnv(hooks, "RUNNER", "r", instance);

    // The object's other bindings and its vars are as they were.
    expect(instance.env["DB"]).toBe(db);
    expect(instance.env["LIMIT"]).toBe(3);
    // Reading the binding, as code building its dependencies from env does, reports nothing.
    const binding = instance.env["PEER"] as { complete(): unknown; fetch(): unknown };
    expect(reasons).toEqual([]);
    expect(Object.keys(instance.env)).toEqual(["PEER", "DB", "LIMIT"]);

    await expect(binding.complete()).rejects.toThrow(
      /called the service binding PEER through its own env/,
    );
    await expect(binding.fetch()).rejects.toThrow(/eutaxy: Durable Object RUNNER r/);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toBe(
      "Durable Object RUNNER r called the service binding PEER through its own env: an object's own binding calls are outside the simulation, so no service() script or callee() answers them",
    );
    // Awaiting the binding itself is not a call.
    expect(await (binding as unknown)).toBe(binding);
    expect(reasons).toHaveLength(2);
    // An RPC getter is: awaited without a call, it is refused too, never a made-up value.
    await expect(
      (async () => await (binding as unknown as { enabled: Promise<boolean> }).enabled)(),
    ).rejects.toThrow(/called the service binding PEER/);
    expect(reasons).toHaveLength(3);
  });

  test("the instance is guarded once, and a later run's call is reported to that run", async () => {
    const first = collecting();
    const second = collecting();
    const instance = { env: { PEER: peer() } as Record<string, unknown> };
    guardEnv(first.hooks, "RUNNER", "r", instance);
    const view = instance.env;
    guardEnv(second.hooks, "RUNNER", "r", instance);
    expect(instance.env).toBe(view);
    await expect(
      (instance.env["PEER"] as { complete(): Promise<unknown> }).complete(),
    ).rejects.toThrow();
    expect(first.reasons).toEqual([]);
    expect(second.reasons).toHaveLength(1);
  });

  test("an instance that keeps no env of its own is left alone", () => {
    const { hooks } = collecting();
    const bare = {};
    const frozen = Object.freeze({ env: { PEER: peer() } });
    guardEnv(hooks, "RUNNER", "r", bare);
    guardEnv(hooks, "RUNNER", "r", frozen);
    guardEnv(hooks, "RUNNER", "r", null);
    expect(Object.keys(bare)).toEqual([]);
    expect(typeof (frozen.env.PEER as { complete(): unknown }).complete).toBe("function");
  });
});
