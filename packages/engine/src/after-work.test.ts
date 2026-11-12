/**
 * Work an object goes on with after its answer (a promise it did not await,
 * a timer it set), where the runtime carries no async context into the
 * object's code: the platform enters it with `hostedCode`, and the engine
 * makes the work the object's own invocation, whose effects the run waits
 * for, as turns in a concurrent run, and whose crash resets the object
 * without touching the caller.
 */
import type { Bounds, EffectRecord, Platform, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { replayChooser, seededChooser } from "./chooser.ts";
import { realTick, virtualEpoch } from "./clock.ts";
import { runInvocation } from "./deliver.ts";
import { runOnce } from "./explore.ts";
import { afterWorkTimerLimit, CrashSignal, Run } from "./run.ts";

const bounds = (concurrent: number): Bounds => ({
  maxFaultsPerRun: 1,
  maxRedeliveries: 0,
  maxConcurrentInvocations: concurrent,
  budgetMs: 2_000,
});
const none = () => null;
const ops = (entries: readonly EffectRecord[]) =>
  entries.map((e) => `${e.invocation} ${e.kind} ${e.op}`);
const HOST = "DO:X/x";

/**
 * One call into the object `x`, as a platform performs it: the object's
 * method runs as the host's code; it answers at once and goes on, after a
 * timer, with `afterwards`, which makes effects of its own.
 */
async function callObject(
  hooks: RunHooks,
  invocation: string,
  onAbandon: () => void,
  afterwards: (running: string) => Promise<void>,
  delayMs = 10,
): Promise<string> {
  return hooks.effect(
    { invocation, target: "DO:X", op: "call", args: null, allowed: [], hostsEffects: true },
    async () =>
      // The runtime hands the method no context of the caller's; the platform enters it as the host's.
      hooks.hostedCode(HOST, () => {
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await afterwards(hooks.running());
        })();
        return "answered";
      }),
    (v) => v,
    { host: HOST, onAbandon },
  );
}

/** The object's own effect: a fetch it makes, named by the invocation the platform sees running. */
const objectFetch = (
  hooks: RunHooks,
  running: string,
  op = "GET",
  allowed: "crash_before"[] = [],
) =>
  hooks.effect(
    { invocation: running, target: "Fetch:api", op, args: null, allowed },
    async () => 1,
    none,
  );

describe("an object's work after its answer", () => {
  test("runs as the object's own invocation, timers included, and a sequential run waits for it", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let done = false;
      let ranAs = "";
      const result = await runInvocation(run, inv, () =>
        callObject(
          run,
          "i#1",
          () => {},
          async (running) => {
            ranAs = running;
            await objectFetch(run, running);
            done = true;
          },
        ),
      );
      expect(result).toEqual({ status: "completed", value: "answered" });
      // The answer crossed with the work still pending: the timer the object set inside the call.
      expect(done).toBe(false);
      expect(run.hasAfterWork()).toBe(true);
      await run.driveAfterWork();
      expect(done).toBe(true);
      expect(run.hasAfterWork()).toBe(false);
      expect(ranAs).toBe("DO:X/x/after");
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
      ]);
      expect(run.now()).toBeGreaterThanOrEqual(virtualEpoch + 10);
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("an effect the object makes inside the call is the call's, whatever invocation the platform named", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () => run.hostedCode(HOST, () => objectFetch(run, "someone-else#1")),
          none,
          { host: HOST },
        ),
      );
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 call GET",
        "i#1 result GET",
        "i#1 result call",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("a crash in the work resets the object and ends its invocation alone; the caller's answer stands", async () => {
    const run = new Run({
      chooser: replayChooser({
        seed: 1,
        faults: [
          {
            invocation: "DO:X/x/after",
            ordinal: 0,
            fault: "crash_before",
            target: "Fetch:api",
            op: "GET",
          },
        ],
      }),
      bounds: bounds(1),
    });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let reset = false;
      let continued = false;
      const result = await runInvocation(run, inv, () =>
        callObject(
          run,
          "i#1",
          () => {
            reset = true;
          },
          async (running) => {
            await objectFetch(run, running, "GET", ["crash_before"]);
            continued = true;
          },
        ),
      );
      await run.driveAfterWork();
      expect(result).toEqual({ status: "completed", value: "answered" });
      expect(inv.isCrashed()).toBe(false);
      expect(reset).toBe(true);
      expect(continued).toBe(false);
      expect(run.hasAfterWork()).toBe(false);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after fault GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("work left by several calls, from several deliveries, is one invocation of the object's, revived as it comes", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const seen: string[] = [];
      for (const id of ["i#1", "i#2"]) {
        const inv = run.startInvocation(id);
        const outcome = await runInvocation(run, inv, () =>
          callObject(
            run,
            id,
            () => {},
            async (running) => {
              seen.push(running);
              await objectFetch(run, running);
            },
          ),
        );
        expect(outcome.status).toBe("completed");
        // Between deliveries, as the run loop does.
        await run.driveAfterWork();
      }
      expect(run.unsupportedReasons).toEqual([]);
      expect(seen).toEqual(["DO:X/x/after", "DO:X/x/after"]);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
        "i#2 call call",
        "i#2 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("after a crash reset the object, its later work is a new invocation of its own", async () => {
    const run = new Run({
      chooser: replayChooser({
        seed: 1,
        faults: [
          {
            invocation: "DO:X/x/after",
            ordinal: 0,
            fault: "crash_before",
            target: "Fetch:api",
            op: "GET",
          },
        ],
      }),
      bounds: bounds(1),
    });
    run.install();
    try {
      const seen: string[] = [];
      for (const id of ["i#1", "i#2"]) {
        const inv = run.startInvocation(id);
        await runInvocation(run, inv, () =>
          callObject(
            run,
            id,
            () => {},
            async (running) => {
              seen.push(running);
              await objectFetch(run, running, "GET", ["crash_before"]);
              seen.push(`${running} done`);
            },
          ),
        );
        await run.driveAfterWork();
      }
      expect(seen).toEqual(["DO:X/x/after", "DO:X/x/after#2", "DO:X/x/after#2 done"]);
      expect(run.hasAfterWork()).toBe(false);
    } finally {
      run.uninstall();
    }
  });

  test("an effect the object started during the call and did not await keeps its work alive until it ends", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let written = false;
      const result = await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              // Issued before the answer, performing real I/O past it, then a write nothing awaits.
              void run
                .effect(
                  { invocation: "i#1", target: "Fetch:api", op: "GET", args: null, allowed: [] },
                  () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 20)),
                  none,
                )
                .then(() => {
                  written = true;
                });
              return "answered";
            }),
          none,
          { host: HOST },
        ),
      );
      expect(result).toEqual({ status: "completed", value: "answered" });
      expect(run.hasAfterWork()).toBe(true);
      await run.driveAfterWork();
      expect(written).toBe(true);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 call GET",
        "i#1 result call",
        "i#1 result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("an effect made inside a timer's callback is the object's own too", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              setTimeout(() => {
                void objectFetch(run, run.running());
              }, 10);
              return "answered";
            }),
          none,
          { host: HOST },
        ),
      );
      await run.driveAfterWork();
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("work that never settles, a heartbeat, makes the run unsupported after its timers fired enough", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let beats = 0;
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              setInterval(() => {
                beats++;
              }, 1_000);
              return "answered";
            }),
          none,
          { host: HOST },
        ),
      );
      await run.driveAfterWork();
      expect(beats).toBe(afterWorkTimerLimit + 1);
      expect(run.hasAfterWork()).toBe(false);
      expect(run.unsupportedReasons.join()).toContain(
        "DO:X/x/after: the object's work after its answer fired its timers",
      );
    } finally {
      run.uninstall();
    }
  });

  test("two calls inside one object at once: each effect is the call's whose code made it", async () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "overlap",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [] },
      setup: [],
      externals: [],
      invariants: [],
      bounds: bounds(2),
    };
    const platform: Platform = {
      name: "objects",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [
        { id: "a", attempt: 1, data: null },
        { id: "b", attempt: 1, data: null },
      ],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const outcome = await runInvocation(hooks, inv, () =>
          hooks.effect(
            {
              invocation: inv.id,
              target: "DO:X",
              op: "call",
              args: null,
              allowed: [],
              hostsEffects: true,
            },
            () =>
              // The object's method, as the platform enters it: two effects, each naming its own call.
              hooks.hostedCode(HOST, async () => {
                for (const op of ["GET", "PUT"]) {
                  await hooks.effect(
                    {
                      invocation: hooks.running(),
                      target: "Fetch:api",
                      op,
                      args: { by: inv.id },
                      allowed: [],
                    },
                    async () => 1,
                    none,
                  );
                }
                return "answered";
              }),
            none,
            { host: HOST },
          ),
        );
        return { status: outcome.status, followUps: [] };
      },
    };
    const run = new Run({ chooser: replayChooser({ seed: 7, faults: [] }), bounds: bounds(2) });
    const log = await runOnce(spec, platform, run);
    expect(run.unsupportedReasons).toEqual([]);
    const made = log.entries.filter((e) => e.kind === "result" && e.target === "Fetch:api");
    expect(made).toHaveLength(4);
    for (const e of made)
      expect(e.invocation).toBe((e.payload as { args: { by: string } }).args.by);
    expect(run.hasAfterWork()).toBe(false);
  });

  test("work after the answer inside blockConcurrencyWhile runs its effects at once, as a call's would", async () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "gated",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [] },
      setup: [],
      externals: [],
      invariants: [],
      bounds: bounds(2),
    };
    let done = false;
    const platform: Platform = {
      name: "objects",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [{ id: "a", attempt: 1, data: null }],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const outcome = await runInvocation(hooks, inv, () =>
          hooks.effect(
            {
              invocation: inv.id,
              target: "DO:X",
              op: "call",
              args: null,
              allowed: [],
              hostsEffects: true,
            },
            async () =>
              hooks.hostedCode(HOST, () => {
                void (async () => {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                  await objectFetch(hooks, hooks.running());
                  done = true;
                })();
                return "answered";
              }),
            none,
            // The gate is held: nothing waits for a turn inside.
            { host: HOST, mayPark: () => false },
          ),
        );
        return { status: outcome.status, followUps: [] };
      },
    };
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(2) });
    const log = await runOnce(spec, platform, run);
    expect(done).toBe(true);
    expect(run.unsupportedReasons).toEqual([]);
    expect(ops(log.entries)).toContain("DO:X/x/after result GET");
  });

  test("the object's code entering again (a method calling another) stays the same call", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      const seen: string[] = [];
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "outer",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(
              HOST,
              async () => {
                seen.push(run.running());
                // The method calls another of the object's, wrapped too: still this call's code.
                await run.hostedCode(
                  HOST,
                  async () => {
                    await objectFetch(run, run.running());
                    seen.push(run.running());
                  },
                  "inner",
                );
                return 1;
              },
              "outer",
            ),
          none,
          { host: HOST },
        ),
      );
      expect(seen).toEqual(["i#1", "i#1"]);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call outer",
        "i#1 call GET",
        "i#1 result GET",
        "i#1 result outer",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("a finished handler's stray interval is not the object's work: the run drains the object's own timers only", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let beats = 0;
      let done = false;
      await runInvocation(run, inv, async () => {
        // The handler's own heartbeat, left running after it answers.
        setInterval(() => {
          beats++;
        }, 5);
        await callObject(
          run,
          "i#1",
          () => {},
          async (running) => {
            await objectFetch(run, running);
            done = true;
          },
        );
      });
      await run.driveAfterWork();
      expect(done).toBe(true);
      expect(run.hasAfterWork()).toBe(false);
      expect(beats).toBe(0);
    } finally {
      run.uninstall();
    }
  });

  test("a finished handler's leftover timeout does not stall a concurrent run before a delayed event", async () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "leftover",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [] },
      setup: [],
      externals: [],
      invariants: [],
      bounds: bounds(2),
    };
    const delivered: string[] = [];
    const platform: Platform = {
      name: "handlers",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [
        { id: "a", attempt: 1, data: null },
        { id: "b", attempt: 1, data: null, at: virtualEpoch + 100 },
      ],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const outcome = await runInvocation(hooks, inv, async () => {
          delivered.push(event.id);
          // A timeout the handler leaves behind, due before the next event.
          if (event.id === "a") setTimeout(() => {}, 10);
        });
        return { status: outcome.status, followUps: [] };
      },
    };
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(2) });
    await runOnce(spec, platform, run);
    expect(delivered).toEqual(["a", "b"]);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("while only an object's work is alive, a delayed event due before the work's timer is delivered first", async () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "ordering",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [] },
      setup: [],
      externals: [],
      invariants: [],
      bounds: bounds(2),
    };
    const order: string[] = [];
    const platform: Platform = {
      name: "objects",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [
        { id: "a", attempt: 1, data: null },
        { id: "b", attempt: 1, data: null, at: virtualEpoch + 50 },
      ],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const outcome = await runInvocation(hooks, inv, async () => {
          order.push(event.id);
          if (event.id !== "a") return;
          // The handler's stray timer, due first; the object's work, due last.
          setTimeout(() => {}, 10);
          await callObject(
            hooks,
            inv.id,
            () => {},
            async (running) => {
              order.push(running);
              await objectFetch(hooks, running);
            },
            100,
          );
        });
        return { status: outcome.status, followUps: [] };
      },
    };
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(2) });
    await runOnce(spec, platform, run);
    expect(order).toEqual(["a", "b", "DO:X/x/after"]);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("the platform dropping the object (an eviction after a crash) ends its work after the answer", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let ran = false;
      await runInvocation(run, inv, () =>
        callObject(
          run,
          "i#1",
          () => {},
          async () => {
            ran = true;
          },
        ),
      );
      expect(run.hasAfterWork()).toBe(true);
      run.hostReset(HOST);
      expect(run.hasAfterWork()).toBe(false);
      await run.driveAfterWork();
      expect(ran).toBe(false);
    } finally {
      run.uninstall();
    }
  });

  test("in a concurrent run the work's effects are turns, the run waits for them, and the same seed gives the same log", async () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "after-work",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [] },
      setup: [],
      externals: [],
      invariants: [],
      bounds: bounds(2),
    };
    const platform: Platform = {
      name: "objects",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [
        { id: "a", attempt: 1, data: null },
        { id: "b", attempt: 1, data: null },
      ],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const outcome = await runInvocation(hooks, inv, () =>
          callObject(
            hooks,
            inv.id,
            () => {},
            async (running) => {
              await objectFetch(hooks, running, "GET");
              await objectFetch(hooks, running, "PUT");
            },
            event.id === "a" ? 10 : 5,
          ),
        );
        return { status: outcome.status, followUps: [] };
      },
    };
    const logs = [];
    for (let i = 0; i < 2; i++) {
      const run = new Run({ chooser: replayChooser({ seed: 3, faults: [] }), bounds: bounds(2) });
      const log = await runOnce(spec, platform, run);
      expect(run.unsupportedReasons).toEqual([]);
      logs.push(ops(log.entries));
    }
    const [first, second] = logs;
    expect(second).toEqual(first);
    // Both calls answered, and the object's work after each ran to its end as its own turns.
    expect(first?.filter((o) => o.endsWith("result call"))).toEqual([
      "a#1 result call",
      "b#1 result call",
    ]);
    expect(first?.filter((o) => o.endsWith("result PUT"))).toEqual([
      "DO:X/x/after result PUT",
      "DO:X/x/after result PUT",
    ]);
  });
});

/** A platform whose every event is one call into the object `x`, with the method `code` runs as the host's code. */
function objectPlatform(
  events: readonly { id: string; at?: number }[],
  code: (event: string, hooks: RunHooks, inv: string) => Promise<unknown>,
  options: { onAbandon?: () => void; host?: string } = {},
): Platform {
  return {
    name: "objects",
    assumptions: [],
    concurrent: true,
    reset: async () => {},
    initialEvents: () =>
      events.map((e) => ({ id: e.id, attempt: 1, data: null, ...(e.at ? { at: e.at } : {}) })),
    restrictEvents: (s) => s,
    async deliver(event, hooks) {
      const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
      const outcome = await runInvocation(hooks, inv, () =>
        hooks.effect(
          {
            invocation: inv.id,
            target: "DO:X",
            op: "call",
            args: null,
            allowed: ["crash_after"],
            hostsEffects: true,
          },
          () => hooks.hostedCode(options.host ?? HOST, () => code(event.id, hooks, inv.id)),
          none,
          { host: options.host ?? HOST, onAbandon: options.onAbandon ?? (() => {}) },
        ),
      );
      return { status: outcome.status, followUps: [] };
    },
  };
}

const spec = (concurrent: number): ScenarioSpec => ({
  version: 1,
  name: "timing",
  worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: [] },
  setup: [],
  externals: [],
  invariants: [],
  bounds: bounds(concurrent),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("code an object runs while a call is entering it", () => {
  /**
   * One call into the object, as a platform performs it against a runtime that constructs the
   * object first: the constructor's work behind the gate (`entering`), then the method.
   */
  const enter = (hooks: RunHooks, invocation: string, entering: () => Promise<void>) =>
    hooks.effect(
      { invocation, target: "DO:X", op: "call", args: null, allowed: [], hostsEffects: true },
      async () => {
        await hooks.hostEntering(HOST, entering);
        return hooks.hostedCode(HOST, () => "answered", "call");
      },
      (v) => v,
      { host: HOST },
    );

  test.each([1, 2])(
    "a timer it awaits is the object's to be woken by, and the call enters after it (%i in flight)",
    async (concurrent) => {
      const order: string[] = [];
      const platform: Platform = {
        name: "objects",
        assumptions: [],
        concurrent: true,
        reset: async () => {},
        initialEvents: () => [{ id: "a", attempt: 1, data: null }],
        restrictEvents: (s) => s,
        async deliver(event, hooks) {
          const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
          const outcome = await runInvocation(hooks, inv, () =>
            enter(hooks, inv.id, async () => {
              order.push("warming");
              await new Promise((resolve) => setTimeout(resolve, 10));
              // Its own effect is the entering call's.
              await objectFetch(hooks, hooks.running(), "warm");
              order.push("warm");
            }),
          );
          order.push(`call ${outcome.status}`);
          return { status: outcome.status, followUps: [] };
        },
      };
      const spec: ScenarioSpec = {
        version: 1,
        name: "entering",
        worker: { entry: "./w.ts", config: "./w.jsonc" },
        drive: { kind: "none" },
        setup: [],
        externals: [],
        invariants: [],
        bounds: bounds(concurrent),
      };
      const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: spec.bounds });
      const log = await runOnce(spec, platform, run);
      expect(run.unsupportedReasons).toEqual([]);
      expect(order).toEqual(["warming", "warm", "call completed"]);
      expect(ops(log.entries)).toEqual([
        "a#1 call call",
        "a#1 call warm",
        "a#1 result warm",
        "a#1 result call",
      ]);
      // The timer was the virtual clock's: time passed to it.
      expect(run.now()).toBeGreaterThanOrEqual(virtualEpoch + 10);
    },
  );
});

describe("two jobs of one object after their answers, each making two effects", () => {
  /** Two calls into the object; each answers and, a timer later, makes a `plan` and then a `charge`. */
  const jobs = (): Platform => ({
    name: "objects",
    assumptions: [],
    concurrent: true,
    reset: async () => {},
    initialEvents: () => [
      { id: "a", attempt: 1, data: null },
      { id: "b", attempt: 1, data: null },
    ],
    restrictEvents: (s) => s,
    async deliver(event, hooks) {
      const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
      const outcome = await runInvocation(hooks, inv, () =>
        callObject(
          hooks,
          inv.id,
          () => {},
          async (running) => {
            await objectFetch(hooks, running, `plan ${event.id}`);
            await objectFetch(hooks, running, `charge ${event.id}`);
          },
        ),
      );
      return { status: outcome.status, followUps: [] };
    },
  });
  const spec: ScenarioSpec = {
    version: 1,
    name: "two-jobs",
    worker: { entry: "./w.ts", config: "./w.jsonc" },
    drive: { kind: "none" },
    setup: [],
    externals: [],
    invariants: [],
    bounds: bounds(2),
  };
  const calls = (entries: readonly EffectRecord[]) =>
    entries.filter((e) => e.kind === "call" && e.target === "Fetch:api").map((e) => e.op);

  test("one job's next effect and the other job's due timer are both options at each decision: the same seed gives the same run, and seeds differ", async () => {
    // After a job's plan answers, its charge must be parked before the scheduler decides again: the
    // turn is released to a poller inside the object, and a decision taken before the object's code
    // has moved would see only the other job's timer.
    const orders = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const runs: string[] = [];
      for (let again = 0; again < 2; again++) {
        const run = new Run({
          chooser: seededChooser(seed, { faultProbability: 0, maxFaultsPerRun: 0 }),
          bounds: bounds(2),
        });
        const log = await runOnce(spec, jobs(), run);
        expect(run.unsupportedReasons).toEqual([]);
        runs.push(calls(log.entries).join(", "));
      }
      expect(runs[1]).toBe(runs[0]);
      expect(runs[0]?.split(", ").sort()).toEqual(["charge a", "charge b", "plan a", "plan b"]);
      orders.add(runs[0] ?? "");
    }
    // A job runs through before the other starts on some seeds, and they interleave on others.
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("an object's timers and effects around its answer", () => {
  test("an object that awaits one of its own timers before answering is woken by it: the call completes", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      const result = await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () =>
            run.hostedCode(HOST, async () => {
              await sleep(10);
              await objectFetch(run, run.running());
              return "answered";
            }),
          (v) => v,
          { host: HOST },
        ),
      );
      expect(result).toEqual({ status: "completed", value: "answered" });
      expect(run.unsupportedReasons).toEqual([]);
      expect(run.now()).toBeGreaterThanOrEqual(virtualEpoch + 10);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 call GET",
        "i#1 result GET",
        "i#1 result call",
      ]);
      await run.driveAfterWork();
      expect(run.hasAfterWork()).toBe(false);
    } finally {
      run.uninstall();
    }
  });

  test("a timer the object set during the call and did not await fires after the answer crossed, not while it is in transit", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () => {
            const answer = run.hostedCode(HOST, async () => {
              setTimeout(() => void objectFetch(run, run.running()), 10);
              return "answered";
            });
            // The answer crosses back over several real ticks, as an RPC's does.
            for (let i = 0; i < 4; i++) await realTick();
            return answer;
          },
          none,
          { host: HOST },
        ),
      );
      await run.driveAfterWork();
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("a call still crossing into its object is not idle: the other object's timer waits for it to enter", async () => {
    // Two calls into two objects: X sleeps; Y's call takes several real ticks to reach its method, as an
    // RPC does. Y's code must have entered before X's timer fires, so the order calls enter their
    // objects is the schedule's, not real time's.
    const order: string[] = [];
    const platform: Platform = {
      name: "objects",
      assumptions: [],
      concurrent: true,
      reset: async () => {},
      initialEvents: () => [
        { id: "x", attempt: 1, data: null },
        { id: "y", attempt: 1, data: null },
      ],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
        const host = `DO:${event.id.toUpperCase()}/${event.id}`;
        const outcome = await runInvocation(hooks, inv, () =>
          hooks.effect(
            {
              invocation: inv.id,
              target: `DO:${event.id.toUpperCase()}`,
              op: "call",
              args: null,
              allowed: [],
              hostsEffects: true,
            },
            async () => {
              if (event.id === "y") for (let i = 0; i < 3; i++) await realTick();
              return hooks.hostedCode(host, async () => {
                order.push(`${event.id} entered`);
                if (event.id === "x") await sleep(10);
                order.push(`${event.id} done`);
                return event.id;
              });
            },
            none,
            { host },
          ),
        );
        return { status: outcome.status, followUps: [] };
      },
    };
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(2) });
    await runOnce(spec(2), platform, run);
    expect(run.unsupportedReasons).toEqual([]);
    expect(order.indexOf("y entered")).toBeLessThan(order.indexOf("x done"));
  });

  test("the caller's own timers stay the caller's: they do not fire while its call is in flight", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let timedOut = false;
      await runInvocation(run, inv, async () => {
        const timeout = sleep(5).then(() => {
          timedOut = true;
        });
        await run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () =>
            run.hostedCode(HOST, async () => {
              await sleep(10);
              return "answered";
            }),
          (v) => v,
          { host: HOST },
        );
        expect(timedOut).toBe(false);
        await timeout;
      });
      expect(timedOut).toBe(true);
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("in a concurrent run the sleeping object's call completes, a delayed event due meanwhile is delivered first, and the log repeats", async () => {
    const order: string[] = [];
    const platform = objectPlatform(
      [{ id: "a" }, { id: "b", at: virtualEpoch + 50 }],
      async (event) => {
        order.push(`${event} in`);
        if (event === "a") await sleep(100);
        order.push(`${event} out at ${Date.now() - virtualEpoch}`);
        return event;
      },
    );
    const logs: string[][] = [];
    for (let i = 0; i < 2; i++) {
      order.length = 0;
      const run = new Run({ chooser: replayChooser({ seed: 3, faults: [] }), bounds: bounds(2) });
      const log = await runOnce(spec(2), platform, run);
      expect(run.unsupportedReasons).toEqual([]);
      logs.push(ops(log.entries));
    }
    expect(logs[1]).toEqual(logs[0]);
    expect(order).toEqual(["a in", "b in", "b out at 50", "a out at 100"]);
  });

  test("work after an answer that calls into another object sleeping before its answer completes too", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let answered: unknown;
      await runInvocation(run, inv, () =>
        callObject(
          run,
          "i#1",
          () => {},
          async (running) => {
            answered = await run.effect(
              {
                invocation: running,
                target: "DO:Y",
                op: "call",
                args: null,
                allowed: [],
                hostsEffects: true,
              },
              () =>
                run.hostedCode("DO:Y/y", async () => {
                  await sleep(10);
                  return "y";
                }),
              (v) => v,
              { host: "DO:Y/y" },
            );
          },
        ),
      );
      await run.driveAfterWork();
      expect(answered).toBe("y");
      expect(run.unsupportedReasons).toEqual([]);
      expect(ops(run.log.entries)).toContain("DO:X/x/after result call");
    } finally {
      run.uninstall();
    }
  });

  test("an effect the object issued before its answer outlives the caller's crash: it is the object's work once the call ended", async () => {
    const run = new Run({
      chooser: replayChooser({
        seed: 1,
        faults: [
          { invocation: "i#1", ordinal: 0, fault: "crash_after", target: "DO:X", op: "call" },
        ],
      }),
      bounds: bounds(1),
    });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let written = false;
      const result = await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: ["crash_after"],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              void run
                .effect(
                  { invocation: "i#1", target: "Fetch:api", op: "GET", args: null, allowed: [] },
                  () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 20)),
                  none,
                )
                .then(() => {
                  written = true;
                });
              return "answered";
            }),
          none,
          { host: HOST },
        ),
      );
      expect(result).toEqual({ status: "crashed" });
      expect(run.hasAfterWork()).toBe(true);
      await run.driveAfterWork();
      expect(written).toBe(true);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 call GET",
        "i#1 result call",
        "i#1 fault call",
        "i#1 result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("a crash injected into such an effect after the answer resets the object, not the caller", async () => {
    const run = new Run({
      chooser: replayChooser({
        seed: 1,
        faults: [
          { invocation: "i#1", ordinal: 1, fault: "crash_after", target: "Fetch:api", op: "GET" },
        ],
      }),
      bounds: bounds(1),
    });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let reset = false;
      let continued = false;
      const result = await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              void run
                .effect(
                  {
                    invocation: "i#1",
                    target: "Fetch:api",
                    op: "GET",
                    args: null,
                    allowed: ["crash_after"],
                  },
                  () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 20)),
                  none,
                )
                .then(() => {
                  continued = true;
                });
              return "answered";
            }),
          none,
          {
            host: HOST,
            onAbandon: () => {
              reset = true;
            },
          },
        ),
      );
      expect(result).toEqual({ status: "completed", value: "answered" });
      await run.driveAfterWork();
      expect(inv.isCrashed()).toBe(false);
      expect(reset).toBe(true);
      expect(continued).toBe(false);
      expect(run.hasAfterWork()).toBe(false);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 call GET",
        "i#1 result call",
        "i#1 result GET",
        "i#1 fault GET",
      ]);
    } finally {
      run.uninstall();
    }
  });

  test("in a concurrent run an effect parked when the answer crossed is the object's own turn, faults included", async () => {
    let reset = false;
    const crashed: string[] = [];
    const platform = objectPlatform(
      [{ id: "a" }, { id: "b" }],
      async (event, hooks) => {
        if (event === "a") {
          // Issued before the answer, not awaited: parked for its turn when the answer crosses.
          void objectFetch(hooks, hooks.running(), "GET", ["crash_before"]).then(
            () => crashed.push("a went on"),
            () => crashed.push("a saw an error"),
          );
        }
        return event;
      },
      {
        onAbandon: () => {
          reset = true;
        },
      },
    );
    const run = new Run({
      chooser: replayChooser({
        seed: 5,
        faults: [
          {
            invocation: "DO:X/x/after",
            ordinal: 0,
            fault: "crash_before",
            target: "Fetch:api",
            op: "GET",
          },
        ],
      }),
      bounds: bounds(2),
    });
    const log = await runOnce(spec(2), platform, run);
    expect(run.unsupportedReasons).toEqual([]);
    const lines = ops(log.entries);
    expect(lines.filter((l) => l.endsWith("result call"))).toEqual([
      "a#1 result call",
      "b#1 result call",
    ]);
    expect(lines).toContain("DO:X/x/after call GET");
    expect(lines).toContain("DO:X/x/after fault GET");
    expect(reset).toBe(true);
    expect(crashed).toEqual([]);
    expect(run.hasAfterWork()).toBe(false);
  });

  test("in a concurrent run a settle on a crashed invocation is released on the run's own step, with the crash signal", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(2) });
    const inv = run.startInvocation("i#1");
    // The promise a crash settled where it happened may never wake its waiters (an object's task
    // being torn down): the run itself releases them at its next step.
    const wait = run.settle(new Promise<never>(() => {}), "i#1");
    const outcome = runInvocation(run, inv, () => new Promise<never>(() => {}));
    const released = expect(wait).rejects.toThrow(CrashSignal);
    expect(run.abandon(["i#1"])).toBe(1);
    expect(inv.isCrashed()).toBe(true);
    await run.quiesce();
    await released;
    await expect(outcome).resolves.toEqual({ status: "crashed" });
  });

  test("a crash in one of two effects the object awaits during the call resets it: the other dies with the instance", async () => {
    let reset = 0;
    const ran: string[] = [];
    const platform = objectPlatform(
      [{ id: "a" }],
      async (_event, hooks) => {
        // Two effects issued together and awaited before the answer: both park, one gets its turn first.
        await Promise.all(
          ["GET", "PUT"].map((op) =>
            objectFetch(hooks, hooks.running(), op, ["crash_before"]).then(() => ran.push(op)),
          ),
        );
        return "answered";
      },
      {
        onAbandon: () => {
          reset++;
        },
      },
    );
    const run = new Run({
      chooser: replayChooser({
        seed: 2,
        faults: [
          { invocation: "a#1", ordinal: 1, fault: "crash_before", target: "Fetch:api", op: "GET" },
        ],
      }),
      bounds: bounds(2),
    });
    const log = await runOnce(spec(2), platform, run);
    expect(run.unsupportedReasons).toEqual([]);
    expect(reset).toBe(1);
    // Neither effect's code went on: the instance that issued them is gone, the other is not the next instance's work.
    expect(ran).toEqual([]);
    const lines = ops(log.entries);
    expect(lines.filter((l) => l.startsWith("DO:X/x/after"))).toEqual([]);
    // The fault hit whichever of the two the seed released first; neither performed.
    expect(lines.filter((l) => /^a#1 fault (GET|PUT)$/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => / result (GET|PUT)$/.test(l))).toEqual([]);
  });

  test("a heartbeat fired by the caller's own wait counts against the bound too", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let beats = 0;
      await runInvocation(run, inv, async () => {
        await run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              setInterval(() => {
                beats++;
              }, 1);
              return "answered";
            }),
          none,
          { host: HOST },
        );
        // The caller goes on waiting on a timer of its own, during which the object's interval fires.
        await sleep(10_000);
      });
      expect(beats).toBe(afterWorkTimerLimit + 1);
      expect(run.unsupportedReasons.join()).toContain("fired its timers");
    } finally {
      run.uninstall();
    }
  });

  test("an object that sleeps once per call is not a heartbeat: the count starts over when its work settles", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      for (let i = 0; i < afterWorkTimerLimit + 5; i++) {
        const inv = run.startInvocation(`i#${i}`);
        await runInvocation(run, inv, () =>
          run.effect(
            {
              invocation: inv.id,
              target: "DO:X",
              op: "call",
              args: null,
              allowed: [],
              hostsEffects: true,
            },
            () =>
              run.hostedCode(HOST, async () => {
                await sleep(1);
                return "answered";
              }),
            none,
            { host: HOST },
          ),
        );
        await run.driveAfterWork();
      }
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("one handler making many sleeping calls in a row is not a heartbeat either: each call ends with nothing outstanding", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      await runInvocation(run, inv, async () => {
        for (let i = 0; i < afterWorkTimerLimit + 5; i++)
          await run.effect(
            {
              invocation: "i#1",
              target: "DO:X",
              op: "call",
              args: null,
              allowed: [],
              hostsEffects: true,
            },
            () =>
              run.hostedCode(HOST, async () => {
                await sleep(1);
                return "answered";
              }),
            none,
            { host: HOST },
          );
      });
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("code that returns or throws after its invocation crashed ended crashed, even where the crash woke nothing", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      // As in workerd when the crash reset the object: the invocation's `crashed` promise wakes no
      // waiter, only its flag tells; the runtime's own error for the aborted call arrives first.
      const silent = (real: ReturnType<Run["startInvocation"]>) => ({
        id: real.id,
        crashed: new Promise<void>(() => {}),
        isCrashed: () => real.isCrashed(),
      });
      const a = run.startInvocation("a#1");
      const thrown = await runInvocation(run, silent(a), async () => {
        run.abandon(["a#1"]);
        throw new Error("the object was aborted");
      });
      expect(thrown).toEqual({ status: "crashed" });
      const b = run.startInvocation("b#1");
      const returned = await runInvocation(run, silent(b), async () => {
        run.abandon(["b#1"]);
        return "late";
      });
      expect(returned).toEqual({ status: "crashed" });
    } finally {
      run.uninstall();
    }
  });

  test("a crash in a call ends the object's work and timers before the platform resets it: a reset that tears its task down loses nothing", async () => {
    const run = new Run({
      chooser: replayChooser({
        seed: 1,
        faults: [
          { invocation: "i#1", ordinal: 1, fault: "crash_before", target: "Fetch:api", op: "GET" },
        ],
      }),
      bounds: bounds(1),
    });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      const seenAtReset: string[] = [];
      const result = await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () =>
            run.hostedCode(HOST, () => {
              // A timer of the object's (another call's sleep, a heartbeat) pending when the crash comes.
              setTimeout(() => {}, 5_000);
              return objectFetch(run, run.running(), "GET", ["crash_before"]);
            }),
          none,
          {
            host: HOST,
            onAbandon: () => {
              // What the platform's reset finds: the object's work ended, its timer gone.
              seenAtReset.push(`afterWork=${run.hasAfterWork()} timerDue=${run.nextTimerDue()}`);
              throw new Error("the object's task is torn down here");
            },
          },
        ),
      );
      expect(result).toEqual({ status: "crashed" });
      expect(seenAtReset).toEqual(["afterWork=false timerDue=undefined"]);
      await run.driveAfterWork();
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("real work the object starts and does not await (a digest) keeps its work alive, and the effect after it is the object's own", async () => {
    const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: bounds(1) });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      let hashed = false;
      await runInvocation(run, inv, () =>
        run.effect(
          {
            invocation: "i#1",
            target: "DO:X",
            op: "call",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () =>
            run.hostedCode(HOST, () => {
              const { subtle } = (
                globalThis as unknown as {
                  crypto: { subtle: { digest(a: string, d: Uint8Array): Promise<unknown> } };
                }
              ).crypto;
              void subtle.digest("SHA-256", new Uint8Array([1, 2, 3])).then(async () => {
                hashed = true;
                await objectFetch(run, run.running());
              });
              return "answered";
            }),
          none,
          { host: HOST },
        ),
      );
      expect(run.hasAfterWork()).toBe(true);
      await run.driveAfterWork();
      expect(hashed).toBe(true);
      expect(ops(run.log.entries)).toEqual([
        "i#1 call call",
        "i#1 result call",
        "DO:X/x/after call GET",
        "DO:X/x/after result GET",
      ]);
    } finally {
      run.uninstall();
    }
  });
});
