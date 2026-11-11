/**
 * The view put over an object's env: the runtime hands an object the Worker's
 * real env, and a call it makes through a service binding there is answered
 * by the scenario's own stub for that binding, or refused when there is none.
 * What the calls do in a run is in object-env.test.ts.
 */
import type { RunHooks } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { ownEnv } from "./object-access.ts";

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

/** The Worker's env as the platform proxies it: under each name, the scenario's stub. */
const scenarioEnv = (names: readonly string[]) => {
  const asked: string[] = [];
  const env = Object.fromEntries(
    names.map((name) => [
      name,
      {
        complete: async (q: string) => {
          asked.push(`${name}.complete(${q})`);
          return `scripted for ${name}`;
        },
      },
    ]),
  );
  return { env, asked };
};

describe("ownEnv", () => {
  test("a service binding on the object's env is the scenario's stub of that name; the rest is as it was", async () => {
    const { hooks, reasons } = collecting();
    const { env: worker, asked } = scenarioEnv(["PEER"]);
    const db = { prepare: () => "statement" };
    const instance = { env: { PEER: peer(), DB: db, LIMIT: 3 } as Record<string, unknown> };
    ownEnv(hooks, "RUNNER", "r", instance, () => worker);

    expect(instance.env["DB"]).toBe(db);
    expect(instance.env["LIMIT"]).toBe(3);
    expect(Object.keys(instance.env)).toEqual(["PEER", "DB", "LIMIT"]);
    const binding = instance.env["PEER"] as { complete(q: string): Promise<string> };
    // Awaiting the binding itself is not a call.
    expect(await (binding as unknown)).toBe(binding);
    expect(asked).toEqual([]);
    expect(await binding.complete("why")).toBe("scripted for PEER");
    expect(asked).toEqual(["PEER.complete(why)"]);
    expect(reasons).toEqual([]);
  });

  test("an object constructed with a callee's view of env reads its bindings back to their qualified names", async () => {
    const { hooks } = collecting();
    const { env: worker, asked } = scenarioEnv(["PEER", "orders/PEER"]);
    const instance = { env: calleeEnv("orders", { "orders/PEER": peer(), PEER: peer() }) };
    ownEnv(hooks, "orders/RUNNER", "r", instance, () => worker);
    const binding = (instance.env as Record<string, unknown>)["PEER"] as {
      complete(q: string): Promise<string>;
    };
    expect(await binding.complete("why")).toBe("scripted for orders/PEER");
    expect(asked).toEqual(["orders/PEER.complete(why)"]);
  });

  test("while a call or a getter's await starts, the object's gate is in the slot for the stub to take, and only then", async () => {
    const { hooks } = collecting();
    const slot: { pending: (() => Promise<void>) | undefined } = { pending: undefined };
    const durable = async () => undefined;
    const seen: unknown[] = [];
    const worker = {
      PEER: {
        complete: Object.assign(
          async () => {
            seen.push(slot.pending);
            await Promise.resolve();
            // Past the synchronous start, the slot is free for the next call.
            seen.push(slot.pending);
          },
          {
            // biome-ignore lint/suspicious/noThenProperty: an RPC property is awaitable as well as callable
            then: (ok: (v: unknown) => unknown) => {
              seen.push(slot.pending);
              return Promise.resolve("value").then(ok);
            },
          },
        ),
      },
    };
    const instance = { env: { PEER: peer() } as Record<string, unknown> };
    ownEnv(hooks, "RUNNER", "r", instance, () => worker, { slot, durable });
    const binding = instance.env["PEER"] as { complete: (() => Promise<void>) & Promise<string> };
    await binding.complete();
    expect(seen).toEqual([durable, undefined]);
    expect(await binding.complete).toBe("value");
    expect(seen).toEqual([durable, undefined, durable]);
    expect(slot.pending).toBeUndefined();
  });

  test("with nothing in the scenario's env to answer, a call or an awaited getter ends the run UNSUPPORTED", async () => {
    const { hooks, reasons } = collecting();
    const instance = { env: { PEER: peer() } as Record<string, unknown> };
    ownEnv(hooks, "RUNNER", "r", instance, () => ({}));
    const binding = instance.env["PEER"] as { complete(): Promise<unknown>; enabled: unknown };
    expect(reasons).toEqual([]);
    await expect(binding.complete()).rejects.toThrow(/eutaxy: Durable Object RUNNER r/);
    await expect((async () => await binding.enabled)()).rejects.toThrow(/service binding PEER/);
    expect(reasons).toEqual([
      "Durable Object RUNNER r called the service binding PEER through its own env, and the scenario's env holds no service binding PEER to answer it",
      "Durable Object RUNNER r called the service binding PEER through its own env, and the scenario's env holds no service binding PEER to answer it",
    ]);
  });

  test("the instance is viewed once, and a later run's refusal is reported to that run", async () => {
    const first = collecting();
    const second = collecting();
    const instance = { env: { PEER: peer() } as Record<string, unknown> };
    ownEnv(first.hooks, "RUNNER", "r", instance);
    const view = instance.env;
    ownEnv(second.hooks, "RUNNER", "r", instance);
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
    ownEnv(hooks, "RUNNER", "r", bare);
    ownEnv(hooks, "RUNNER", "r", frozen);
    ownEnv(hooks, "RUNNER", "r", null);
    expect(Object.keys(bare)).toEqual([]);
    expect(typeof (frozen.env.PEER as { complete(): unknown }).complete).toBe("function");
  });
});
