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
import { replayChooser } from "./chooser.ts";
import { virtualEpoch } from "./clock.ts";
import { runInvocation } from "./deliver.ts";
import { runOnce } from "./explore.ts";
import { afterWorkTimerLimit, Run } from "./run.ts";

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
