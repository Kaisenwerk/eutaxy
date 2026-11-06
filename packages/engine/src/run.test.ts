/**
 * The run's log: appended in place as effects record, handed out as a
 * snapshot that nothing recorded later changes.
 */
import { describe, expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { realTick } from "./clock.ts";
import { runInvocation } from "./deliver.ts";
import { Run } from "./run.ts";

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 0,
  maxConcurrentInvocations: 1,
  budgetMs: 1000,
};

describe("the run's log", () => {
  test("records are numbered in order and a read sees every record so far", async () => {
    const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    const inv = run.startInvocation("i");
    const point = (op: string) => ({ invocation: "i", target: "T", op, args: null, allowed: [] });
    await runInvocation(run, inv, async () => {
      await run.effect(
        point("a"),
        async () => 1,
        (v) => v,
      );
      expect(run.log.entries.map((e) => `${e.seq} ${e.kind} ${e.op}`)).toEqual([
        "0 call a",
        "1 result a",
      ]);
      await run.effect(
        point("b"),
        async () => 2,
        (v) => v,
      );
    });
    expect(run.log.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(run.log).toBe(run.log);
  });

  test("a log handed out does not change when an abandoned effect's I/O records late", async () => {
    // "a" is in flight, not awaited, when "b" crashes the invocation: the run ends, and only later
    // does "a"'s I/O complete and record its result.
    const run = new Run({
      bounds,
      chooser: replayChooser({
        seed: 1,
        faults: [{ invocation: "i", ordinal: 1, fault: "crash_before", target: "T", op: "b" }],
      }),
    });
    const inv = run.startInvocation("i");
    const point = (op: string) => ({
      invocation: "i",
      target: "T",
      op,
      args: null,
      allowed: ["crash_before" as const],
    });
    let finishA: () => void = () => {};
    const slow = new Promise<number>((resolve) => {
      finishA = () => resolve(1);
    });
    const outcome = await runInvocation(run, inv, async () => {
      void run
        .effect(
          point("a"),
          () => slow,
          (v) => v,
        )
        .catch(() => {});
      await run.effect(
        point("b"),
        async () => 2,
        (v) => v,
      );
    });
    expect(outcome).toEqual({ status: "crashed" });
    const returned = run.log;
    const seen = returned.entries.map((e) => `${e.kind} ${e.op}`);
    expect(seen).toEqual(["call a", "call b", "fault b"]);
    finishA();
    for (let i = 0; i < 3; i++) await realTick();
    expect(returned.entries.map((e) => `${e.kind} ${e.op}`)).toEqual(seen);
    // A later read is a new snapshot, with the late record in it.
    expect(run.log.entries.map((e) => `${e.kind} ${e.op}`)).toEqual([...seen, "result a"]);
  });
});
