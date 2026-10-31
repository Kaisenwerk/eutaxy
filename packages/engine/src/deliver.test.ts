/**
 * The delivery skeleton: user code run as an invocation ends as completed,
 * errored or crashed, and a crash is a crash whether the code threw the
 * signal or hung on an effect the fault abandoned.
 */
import { describe, expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { runInvocation } from "./deliver.ts";
import { CrashSignal, Run } from "./run.ts";

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 0,
  maxConcurrentInvocations: 1,
  budgetMs: 1000,
};

describe("runInvocation", () => {
  test("a value returned, synchronously or not, is completed", async () => {
    const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    const inv = run.startInvocation("i");
    expect(await runInvocation(run, inv, () => 1)).toEqual({ status: "completed", value: 1 });
    expect(await runInvocation(run, inv, async () => "two")).toEqual({
      status: "completed",
      value: "two",
    });
  });

  test("anything thrown but a crash signal is errored, with the error", async () => {
    const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    const inv = run.startInvocation("i");
    const boom = new Error("boom");
    expect(
      await runInvocation(run, inv, () => {
        throw boom;
      }),
    ).toEqual({ status: "errored", error: boom });
    expect(await runInvocation(run, inv, () => Promise.reject("plain"))).toEqual({
      status: "errored",
      error: "plain",
    });
  });

  test("a crash signal thrown by the code is crashed", async () => {
    const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    const inv = run.startInvocation("i");
    expect(
      await runInvocation(run, inv, () => {
        throw new CrashSignal("i");
      }),
    ).toEqual({ status: "crashed" });
  });

  test("code hung on an effect a fault abandoned is crashed too, without waiting for it", async () => {
    const run = new Run({
      bounds,
      chooser: replayChooser({
        seed: 1,
        faults: [{ invocation: "i", ordinal: 0, fault: "crash_before", target: "T", op: "o" }],
      }),
    });
    const inv = run.startInvocation("i");
    const outcome = await runInvocation(run, inv, () =>
      run.effect(
        { invocation: "i", target: "T", op: "o", args: null, allowed: ["crash_before"] },
        async () => 1,
        (v) => v,
      ),
    );
    expect(outcome).toEqual({ status: "crashed" });
    expect(inv.isCrashed()).toBe(true);
  });
});
