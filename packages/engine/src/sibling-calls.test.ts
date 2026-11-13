/**
 * Several calls into objects in flight at once, where the runtime carries
 * no async context into an object's code: an effect an object makes is its
 * own call's, not the call that happened to start last, so a crash in it
 * resets that object and no other; and a call an object made that is still
 * in flight when the object is reset is not waited for, since what awaited
 * it went with the object.
 */
import type { Bounds, EffectRecord } from "@eutaxy/core";
import { expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { realTick } from "./clock.ts";
import { runInvocation } from "./deliver.ts";
import { Run } from "./run.ts";

const bounds: Bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 0,
  maxConcurrentInvocations: 1,
  budgetMs: 2_000,
};
const none = () => null;
const ops = (entries: readonly EffectRecord[]) =>
  entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

interface Resource {
  runInAsyncScope<T>(code: () => T): T;
}
// Reached as the engine reaches async context: it has no Node types of its own.
const asyncHooks = process?.getBuiltinModule?.("node:async_hooks") as
  | { AsyncResource: new (name: string) => Resource }
  | undefined;
if (!asyncHooks) throw new Error("these tests need node:async_hooks");

/** Created outside every run: code run in it has no async context of a caller's, as an object's code has none in the runtime. */
const runtime = new asyncHooks.AsyncResource("runtime");

/** One call into the object `name`, whose method the runtime enters without the caller's context. */
function callObject<T>(
  run: Run,
  name: string,
  reset: string[],
  method: () => Promise<T>,
): Promise<T> {
  const host = `DO:X/${name}`;
  return run.effect(
    { invocation: "i#1", target: "DO:X", op: name, args: null, allowed: [], hostsEffects: true },
    async () => runtime.runInAsyncScope(() => run.hostedCode(host, method, name)),
    none,
    { host, onAbandon: () => void reset.push(name) },
  );
}

test("a crash in an effect one object makes resets that object, with another object's call in flight beside it", async () => {
  const run = new Run({
    chooser: replayChooser({
      seed: 1,
      faults: [
        { invocation: "i#1", ordinal: 2, fault: "crash_before", target: "Fetch:api", op: "GET" },
      ],
    }),
    bounds,
  });
  run.install();
  const reset: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const inv = run.startInvocation("i#1");
    const result = await runInvocation(run, inv, () =>
      Promise.all([
        // The first object calls out once the second object's call is in flight too.
        callObject(run, "a", reset, async () => {
          await Promise.resolve();
          await Promise.resolve();
          return run.effect(
            // The platform names the invocation it sees running; the engine knows whose call this is.
            {
              invocation: run.running(),
              target: "Fetch:api",
              op: "GET",
              args: null,
              allowed: ["crash_before"],
            },
            async () => 1,
            none,
          );
        }),
        callObject(run, "b", reset, () => held),
      ]),
    );
    expect(result.status).toBe("crashed");
    expect(ops(run.log.entries)).toEqual([
      "i#1 call DO:X a",
      "i#1 call DO:X b",
      "i#1 call Fetch:api GET",
      "i#1 fault Fetch:api GET",
    ]);
    // The object whose code made the effect is the one reset.
    expect(reset).toEqual(["a"]);
  } finally {
    release();
    run.uninstall();
  }
});

test("an object reset while a call it made into another object is in flight: the run does not wait for that call", async () => {
  const run = new Run({
    chooser: replayChooser({
      seed: 1,
      faults: [
        { invocation: "i#1", ordinal: 3, fault: "crash_before", target: "Fetch:api", op: "GET" },
      ],
    }),
    bounds,
  });
  run.install();
  const reset: string[] = [];
  // The runtime tears a reset object's context down: what was awaiting in it never resumes.
  const torn = new Promise<never>(() => {});
  try {
    const inv = run.startInvocation("i#1");
    const result = await runInvocation(run, inv, async () => {
      // The object starts a call into another object and answers without waiting for it.
      await callObject(run, "s", reset, async () => {
        void run.effect(
          {
            invocation: run.running(),
            target: "DO:X",
            op: "g",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () => torn,
          none,
          { host: "DO:X/g", onAbandon: () => void reset.push("g") },
        );
        return "answered";
      });
      // Called again, it makes an effect that crashes: the object is reset.
      return callObject(run, "s", reset, () =>
        run.effect(
          {
            invocation: run.running(),
            target: "Fetch:api",
            op: "GET",
            args: null,
            allowed: ["crash_before"],
          },
          async () => 1,
          none,
        ),
      );
    });
    expect(result.status).toBe("crashed");
    expect(reset).toEqual(["s"]);
    const atRest = await Promise.race([
      run.driveAfterWork().then(() => true),
      (async () => {
        for (let i = 0; i < 500; i++) await realTick();
        return false;
      })(),
    ]);
    expect(atRest).toBe(true);
    expect(run.unsupportedReasons).toEqual([]);
  } finally {
    run.uninstall();
  }
});

test("an object reset while a call it made into itself is running: that call's code went with it, and nothing stays in flight", async () => {
  const run = new Run({
    chooser: replayChooser({
      seed: 1,
      faults: [
        { invocation: "i#1", ordinal: 3, fault: "crash_before", target: "Fetch:api", op: "GET" },
      ],
    }),
    bounds,
  });
  run.install();
  const reset: string[] = [];
  const torn = new Promise<never>(() => {});
  try {
    const inv = run.startInvocation("i#1");
    const result = await runInvocation(run, inv, async () => {
      // The object calls itself through its own stub and answers without waiting; the call's
      // code has started and is waiting on something of its own.
      await callObject(run, "s", reset, async () => {
        void run.effect(
          {
            invocation: run.running(),
            target: "DO:X",
            op: "self",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          async () => runtime.runInAsyncScope(() => run.hostedCode("DO:X/s", () => torn, "self")),
          none,
          { host: "DO:X/s" },
        );
        return "answered";
      });
      return callObject(run, "s", reset, () =>
        run.effect(
          {
            invocation: run.running(),
            target: "Fetch:api",
            op: "GET",
            args: null,
            allowed: ["crash_before"],
          },
          async () => 1,
          none,
        ),
      );
    });
    expect(result.status).toBe("crashed");
    expect(reset).toEqual(["s"]);
    // The run's own count of effects in flight: the self-call is not kept waiting for an answer.
    expect((run as unknown as { frames: { inFlight: number } }).frames.inFlight).toBe(0);
  } finally {
    run.uninstall();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchOf = (run: Run, op: string, allowed: "crash_before"[] = []) =>
  run.effect(
    { invocation: run.running(), target: "Fetch:api", op, args: null, allowed },
    async () => 1,
    none,
  );
const inFlight = (run: Run) => (run as unknown as { frames: { inFlight: number } }).frames.inFlight;

test("an object reset while the object it called naps: that object wakes and finishes as its own work, and the run waits for it", async () => {
  const run = new Run({
    chooser: replayChooser({
      seed: 1,
      faults: [
        { invocation: "i#1", ordinal: 2, fault: "crash_before", target: "Fetch:api", op: "GET" },
      ],
    }),
    bounds,
  });
  run.install();
  const reset: string[] = [];
  try {
    const inv = run.startInvocation("i#1");
    const result = await runInvocation(run, inv, () =>
      callObject(run, "a", reset, async () => {
        // The call into the second object is in flight, its code asleep, when the first object's
        // own effect takes the crash.
        const b = callObject(run, "b", reset, async () => {
          await sleep(10);
          await fetchOf(run, "woke");
          return "b";
        });
        await Promise.resolve();
        await Promise.resolve();
        await fetchOf(run, "GET", ["crash_before"]);
        return b;
      }),
    );
    expect(result.status).toBe("crashed");
    expect(reset).toEqual(["a"]);
    await run.driveAfterWork();
    expect(run.unsupportedReasons).toEqual([]);
    // No result of the call: nobody was left to take the answer.
    expect(ops(run.log.entries)).toEqual([
      "i#1 call DO:X a",
      "i#1 call DO:X b",
      "i#1 call Fetch:api GET",
      "i#1 fault Fetch:api GET",
      "DO:X/b/after call Fetch:api woke",
      "DO:X/b/after result Fetch:api woke",
    ]);
    expect(inFlight(run)).toBe(0);
  } finally {
    run.uninstall();
  }
});

test("an object reset while the object it called waits on something nothing gives: the call ends at the budget, as any effect does", async () => {
  const run = new Run({
    chooser: replayChooser({
      seed: 1,
      faults: [
        { invocation: "i#1", ordinal: 2, fault: "crash_before", target: "Fetch:api", op: "GET" },
      ],
    }),
    bounds: { ...bounds, budgetMs: 200 },
  });
  run.install();
  const reset: string[] = [];
  // What awaited the call went with the first object: the effect's own deadline is never seen there.
  const never = new Promise<never>(() => {});
  try {
    const inv = run.startInvocation("i#1");
    const result = await runInvocation(run, inv, () =>
      callObject(run, "a", reset, async () => {
        void run.effect(
          {
            invocation: run.running(),
            target: "DO:X",
            op: "b",
            args: null,
            allowed: [],
            hostsEffects: true,
          },
          () => {
            // The second object's code starts and never answers; nothing in the first object's
            // context sees the call again.
            void runtime.runInAsyncScope(() => run.hostedCode("DO:X/b", () => never, "b"));
            return never;
          },
          none,
          { host: "DO:X/b", onAbandon: () => void reset.push("b") },
        );
        await Promise.resolve();
        await Promise.resolve();
        return fetchOf(run, "GET", ["crash_before"]);
      }),
    );
    expect(result.status).toBe("crashed");
    expect(reset).toEqual(["a"]);
    await run.driveAfterWork();
    expect(run.unsupportedReasons).toEqual(["DO:X b did not complete within 200 ms of real time"]);
    expect(reset).toEqual(["a", "b"]);
    expect(inFlight(run)).toBe(0);
  } finally {
    run.uninstall();
  }
});
