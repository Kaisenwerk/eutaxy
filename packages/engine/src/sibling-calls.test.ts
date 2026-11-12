/**
 * Two calls into objects in flight at once in one invocation, where the
 * runtime carries no async context into an object's code: an effect an
 * object makes is its own call's, not the call that happened to start
 * last, so a crash in it resets that object and no other.
 */
import type { Bounds, EffectRecord } from "@eutaxy/core";
import { expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
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
