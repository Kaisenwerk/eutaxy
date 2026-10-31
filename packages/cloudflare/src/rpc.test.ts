/**
 * The RPC drive in Node, with a stand-in for the runtime's `WorkerEntrypoint`
 * base class: a method call is an event, its return value the response, an
 * exception the error the caller sees, and the declared caller resends a
 * call that threw or got no answer.
 */
import { atMostOncePerKey, type EffectLog, type ScenarioSpec, type Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerEntrypointClass } from "./platform.ts";
import { atLeastOncePerMessage, defineScenario, rpc, rpcResponse } from "./scenario.ts";

/** The runtime's base class, as far as construction goes: it is found by name. */
class WorkerEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

interface Env {
  readonly LOG: { calls: string[] };
}

/** An inventory service: reserve() writes a reservation and answers with it. */
class Inventory extends WorkerEntrypoint<Env> {
  /** Instances per run, to show the runtime's one instance per call. */
  static constructed = 0;
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    Inventory.constructed++;
  }
  async reserve(orderId: string, qty: number): Promise<{ reserved: string; qty: number }> {
    this.env.LOG.calls.push(`reserve ${orderId} ${qty}`);
    return { reserved: orderId, qty };
  }
  fail(message: string): never {
    this.env.LOG.calls.push(`fail at ${Date.now()}`);
    throw new RangeError(message);
  }
  later(): void {
    this.ctx.waitUntil(Promise.resolve().then(() => this.env.LOG.calls.push("later")));
  }
  stub(): object {
    return { release: () => undefined };
  }
  /** A function-valued field: not a method RPC exposes. */
  field = (): number => 2;
  /** Mutates its argument: the caller's copy must not change. */
  take(order: { qty: number }): number {
    order.qty -= 1;
    return order.qty;
  }
}

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 3,
  maxConcurrentInvocations: 1,
  budgetMs: 10_000,
};

function spec(drive: ScenarioSpec["drive"], overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    version: 1,
    name: "rpc",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive,
    setup: [],
    externals: [],
    invariants: [],
    bounds,
    ...overrides,
  };
}

async function run(
  s: ScenarioSpec,
  handler: WorkerEntrypointClass | object = Inventory,
  faults: Schedule["faults"] = [],
  exports?: Readonly<Record<string, unknown>>,
): Promise<{ log: EffectLog; env: Env; run: Run }> {
  const env: Env = { LOG: { calls: [] } };
  const platform = createCloudflarePlatform({
    env,
    handler: handler as WorkerEntrypointClass,
    schemas: {},
    ...(exports ? { exports } : {}),
  });
  const r = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds: s.bounds });
  const log = await runOnce(s, platform, r);
  return { log, env, run: r };
}

const ops = (log: EffectLog) =>
  log.entries.filter((e) => e.kind !== "snapshot").map((e) => `${e.invocation} ${e.kind} ${e.op}`);
const payloads = (log: EffectLog, op: string) =>
  log.entries.filter((e) => e.kind === "result" && e.op === op).map((e) => e.payload);

describe("a call is an event and its answer the response", () => {
  test("the return value is recorded, under the method's target, and the caller accepts it", async () => {
    Inventory.constructed = 0;
    const { log, env } = await run(spec(rpc([{ method: "reserve", args: ["o-1", 2] }])));
    expect(ops(log)).toEqual(["call-1#1 call response", "call-1#1 result response"]);
    expect(log.entries[1]?.target).toBe("Rpc:reserve");
    expect(payloads(log, "response")).toEqual([
      {
        args: { callId: "call-1", method: "reserve", args: ["o-1", 2] },
        result: { ok: true, value: { reserved: "o-1", qty: 2 } },
      },
    ]);
    expect(env.LOG.calls).toEqual(["reserve o-1 2"]);
    expect(Inventory.constructed).toBe(1);
  });

  test("each call constructs the entrypoint anew, as the runtime does", async () => {
    Inventory.constructed = 0;
    await run(
      spec(
        rpc([
          { method: "reserve", args: ["a", 1] },
          { method: "reserve", args: ["b", 1] },
        ]),
      ),
    );
    expect(Inventory.constructed).toBe(2);
  });

  test("an exception is the error the caller sees: its name and message, recorded without a fault", async () => {
    const { log } = await run(spec(rpc([{ method: "fail", args: ["out of stock"] }])));
    expect(payloads(log, "response")).toEqual([
      {
        args: { callId: "call-1", method: "fail", args: ["out of stock"] },
        result: { ok: false, error: "RangeError: out of stock" },
      },
    ]);
    // retries 0 by default: the caller stops at once.
    expect(ops(log)).toEqual([
      "call-1#1 call response",
      "call-1#1 result response",
      "platform call gave_up",
      "platform result gave_up",
    ]);
  });

  test("a method the entrypoint lacks is an error the caller sees", async () => {
    const { log } = await run(spec(rpc([{ method: "missing" }])));
    expect(payloads(log, "response")[0]).toMatchObject({
      result: {
        ok: false,
        error: 'TypeError: The RPC receiver does not implement the method "missing".',
      },
    });
  });

  test("only methods the class defines are callable: not a function field, not Object's own", async () => {
    const { log } = await run(
      spec(rpc([{ method: "field" }, { method: "toString" }, { method: "hasOwnProperty" }])),
    );
    expect(
      payloads(log, "response").map((p) => (p as { result: { ok: boolean } }).result.ok),
    ).toEqual([false, false, false]);
  });

  test("arguments travel by copy: a method that mutates one changes neither the scenario nor a resend", async () => {
    const drive = rpc([{ method: "take", args: [{ qty: 3 }] }], { retries: 1 });
    const faults: Schedule["faults"] = [
      {
        invocation: "call-1#1",
        ordinal: 0,
        fault: "crash_before",
        target: "Rpc:take",
        op: "response",
      },
    ];
    const { log } = await run(spec(drive), Inventory, faults);
    expect(payloads(log, "response")).toEqual([
      {
        args: { callId: "call-1", method: "take", args: [{ qty: 3 }] },
        result: { ok: true, value: 2 },
      },
    ]);
    expect(drive.calls[0]?.args).toEqual([{ qty: 3 }]);
  });

  test("background work runs after the answer and is a point of its own", async () => {
    const { log, env } = await run(spec(rpc([{ method: "later" }])));
    expect(ops(log)).toEqual([
      "call-1#1 call response",
      "call-1#1 result response",
      "call-1#1 call background",
      "call-1#1 result background",
    ]);
    expect(env.LOG.calls).toEqual(["later"]);
  });

  test("a result that is not plain data makes the run unsupported", async () => {
    const { run: r } = await run(spec(rpc([{ method: "stub" }])));
    expect(r.unsupportedReasons.join()).toContain("RPC capabilities are not modelled");
  });
});

describe("the caller's policy", () => {
  test("a crash before the response makes the caller resend, up to its retries, then give up", async () => {
    const drive = rpc([{ method: "reserve", args: ["o-1", 1] }], { retries: 1 });
    const faults: Schedule["faults"] = [
      {
        invocation: "call-1#1",
        ordinal: 0,
        fault: "crash_before",
        target: "Rpc:reserve",
        op: "response",
      },
    ];
    const { log, env } = await run(spec(drive), Inventory, faults);
    expect(ops(log)).toEqual([
      "call-1#1 call response",
      "call-1#1 fault response",
      "call-1#2 call response",
      "call-1#2 result response",
    ]);
    // The method ran twice: the first answer was lost, not the work.
    expect(env.LOG.calls).toEqual(["reserve o-1 1", "reserve o-1 1"]);
  });

  test("an error is resent too, and the retries end in gave_up with the attempts", async () => {
    const drive = rpc([{ method: "fail", args: ["no"] }], { retries: 2 });
    const { log } = await run(spec(drive));
    expect(ops(log).filter((o) => o.endsWith("result response"))).toHaveLength(3);
    expect(payloads(log, "gave_up")).toEqual([
      { args: { callId: "call-1", attempts: 3 }, result: null },
    ]);
  });

  test("resends wait the declared virtual delay", async () => {
    const drive = rpc([{ method: "fail", args: ["no"] }], { retries: 1, delaysMs: [5000] });
    const { env } = await run(spec(drive));
    const at = env.LOG.calls.map((c) => Number(c.replace("fail at ", "")));
    expect(at).toHaveLength(2);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(5000);
  });
});

describe("where the entrypoint comes from", () => {
  test("a named entrypoint is found among the Worker module's exports, and names the target", async () => {
    const drive = rpc([{ method: "reserve", args: ["o-1", 1] }], { entrypoint: "Inventory" });
    const { log } = await run(spec(drive), {}, [], { Inventory });
    expect(log.entries[1]?.target).toBe("Rpc:Inventory.reserve");
    expect(rpcResponse("reserve", { entrypoint: "Inventory", ok: true })).toEqual({
      target: "Rpc:Inventory.reserve",
      op: "response",
      kind: "result",
      where: { "result.ok": true },
    });
  });

  test("a default export that is not an entrypoint class makes the run unsupported", async () => {
    const { log, run: r } = await run(spec(rpc([{ method: "reserve" }])), {
      fetch: () => new Response(),
    });
    expect(r.unsupportedReasons.join()).toContain("is not a WorkerEntrypoint class");
    expect(ops(log)).toEqual([]);
  });

  test("a class that does not extend WorkerEntrypoint is an error the caller sees", async () => {
    class Plain {
      reserve(): string {
        return "x";
      }
    }
    const { log } = await run(spec(rpc([{ method: "reserve" }])), Plain);
    expect(payloads(log, "response")[0]).toMatchObject({
      result: { ok: false, error: "TypeError: Plain does not extend WorkerEntrypoint" },
    });
  });
});

describe("the drive in a scenario", () => {
  test("defineScenario validates calls and the caller's policy", () => {
    const base = {
      name: "s",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      invariants: [atMostOncePerKey("once", rpcResponse("reserve"), "args.callId")],
    };
    let message = "";
    try {
      defineScenario({
        ...base,
        drive: rpc(
          [
            { id: "a", method: "constructor" },
            { id: "a", method: "1bad" },
          ],
          {
            retries: -1,
            entrypoint: "not a name",
          },
        ),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const problem of [
      "calls[0].method must be a method name",
      "calls[1].method must be a method name",
      'duplicate call id "a"',
      "rpc drive entrypoint must be an exported class name",
      "rpc drive retries must be a non-negative integer",
    ])
      expect(message).toContain(problem);
    const ok = defineScenario({ ...base, drive: rpc([{ method: "reserve", args: [1] }]) });
    expect(ok.drive).toEqual({
      kind: "rpc",
      calls: [{ id: "call-1", method: "reserve", args: [1] }],
      retries: 0,
    });
  });

  test("atLeastOncePerMessage reads each call's arguments by path", async () => {
    const drive = rpc([
      { method: "reserve", args: [{ orderId: "o-1" }] },
      { method: "reserve", args: [{ orderId: "o-2" }] },
    ]);
    const inv = atLeastOncePerMessage(
      "all",
      drive,
      rpcResponse("reserve"),
      "args.args.0.orderId",
      "0.orderId",
    );
    expect(inv.expected).toEqual(["o-1", "o-2"]);
    expect(inv.perMessage).toEqual({ bodyKey: "args.0.orderId" });
  });

  test("restricting the drive keeps only the named calls", async () => {
    const drive = rpc([
      { method: "reserve", args: ["a", 1] },
      { method: "reserve", args: ["b", 1] },
    ]);
    const platform = createCloudflarePlatform({ env: {}, handler: Inventory, schemas: {} });
    const kept = platform.restrictEvents(spec(drive), ["call-2"]);
    expect(platform.initialEvents(kept).map((e) => e.id)).toEqual(["call-2"]);
  });
});
