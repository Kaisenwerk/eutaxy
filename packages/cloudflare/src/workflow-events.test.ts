/**
 * Workflow events in the model: a wait with no event suspends the instance,
 * an event or the deadline wakes it, the result is persisted like a step's,
 * and the binding's sendEvent buffers events the instance has not waited
 * for yet.
 */
import type { EffectRecord, JsonValue, Platform, ScenarioSpec } from "@eutaxy/core";
import { Run, replayChooser, runOnce, virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import {
  defineScenario,
  external,
  type HttpRequestInput,
  http,
  workflow,
  workflowRows,
} from "./scenario.ts";

/** workerd's base refuses to be constructed outside the runtime; this one refuses always. */
class WorkflowEntrypoint {
  constructor() {
    throw new TypeError("Failed to construct 'WorkflowEntrypoint'");
  }
}

type Step = {
  do(name: string, fn: () => unknown): Promise<unknown>;
  sleep(name: string, d: unknown): Promise<void>;
  waitForEvent(name: string, o: { type: string; timeout?: string }): Promise<unknown>;
};
type Received = { payload: unknown; timestamp: Date; type: string };
type Params = {
  id: string;
  waits?: number;
  timeout?: string;
  catchIt?: boolean;
  swallow?: boolean;
  /** Two waits in a row, each timing out after a minute and caught by the error's name. */
  twoTimeouts?: boolean;
};

/** What each run saw, for the assertions. */
let seen: string[] = [];

/** Waits for an approval, then notifies in a step; with two waits when asked. */
class ApprovalFlow extends WorkflowEntrypoint {
  async run(event: { payload: Params }, step: Step) {
    seen.push(`run ${event.payload.id} at ${Date.now() - virtualEpoch}`);
    if (event.payload.twoTimeouts) {
      const names: string[] = [];
      for (const name of ["first", "second"]) {
        try {
          await step.waitForEvent(name, { type: "never", timeout: "1 minute" });
        } catch (err) {
          if ((err as Error).name !== "WorkflowTimeoutError") throw err;
          names.push((err as Error).name);
        }
      }
      return { names };
    }
    const got: Received[] = [];
    try {
      got.push(
        (await step.waitForEvent("approval", {
          type: "approved",
          ...(event.payload.timeout === undefined ? {} : { timeout: event.payload.timeout }),
        })) as Received,
      );
      if (event.payload.waits === 2)
        got.push((await step.waitForEvent("second", { type: "signed" })) as Received);
    } catch (err) {
      if (event.payload.swallow) {
        // Catching the suspension itself: not modelled, and reported.
        return step.do("after swallow", () => "continued");
      }
      if (!event.payload.catchIt) throw err;
      seen.push(`caught ${(err as Error).name}: ${(err as Error).message}`);
      return { timedOut: true };
    }
    await step.do("notify", async () => {
      await fetch("https://notify.example/send", {
        method: "POST",
        body: JSON.stringify({
          id: event.payload.id,
          by: got.map((g) => (g.payload as { by: string }).by),
        }),
      });
    });
    return {
      received: got.map((g) => ({
        type: g.type,
        by: (g.payload as { by: string }).by,
        at: g.timestamp.getTime() - virtualEpoch,
      })),
    };
  }
}

/** A stand-in for the real binding, so the env value is recognised as a Workflow binding. */
const realBinding = { create() {}, createBatch() {}, get() {} };

type Env = {
  FLOW: {
    create(o: unknown): Promise<unknown>;
    get(id: string): Promise<{ sendEvent(e: unknown): Promise<void> }>;
  };
};

/** POST /start creates an instance; POST /event sends one. */
const worker: WorkerHandler = {
  async fetch(request, env) {
    const e = env as Env;
    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;
    if (url.pathname === "/start") {
      await e.FLOW.create({ id: body["id"], params: body });
      return new Response("started");
    }
    if (url.pathname === "/event") {
      // A slow handler: it holds the only invocation slot while the clock passes a wait's deadline.
      if (typeof body["delayMs"] === "number")
        await new Promise((r) => setTimeout(r, body["delayMs"] as number));
      try {
        const instance = await e.FLOW.get(body["id"] as string);
        await instance.sendEvent({ type: body["type"], payload: body["payload"] });
        return new Response("sent");
      } catch (err) {
        return new Response(String(err), { status: 409 });
      }
    }
    return new Response("not found", { status: 404 });
  },
};

function scenario(requests: readonly HttpRequestInput[], retries = 0): ScenarioSpec {
  return defineScenario({
    name: "approvals",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: http(requests, { retries }),
    setup: [workflow("FLOW", "ApprovalFlow")],
    externals: [external("notify", "notify.example", { responses: [{ status: 200 }] })],
    invariants: [{ kind: "unique", name: "one-run", query: workflowRows("FLOW"), path: "id" }],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1 },
  });
}

/**
 * Run the scenario; `delays` holds requests back by index (virtual ms after
 * the epoch), since initial events are delivered first-in first-out and a
 * wait can only be tested when its event comes after the run suspended.
 */
async function run(
  spec: ScenarioSpec,
  faults: Run["schedule"]["faults"] = [],
  delays: { readonly [index: number]: number } = {},
): Promise<Run> {
  seen = [];
  const base = createCloudflarePlatform({
    env: { FLOW: realBinding },
    handler: worker,
    schemas: {},
    exports: { ApprovalFlow },
  });
  const platform: Platform = {
    ...base,
    initialEvents: (s) =>
      base
        .initialEvents(s)
        .map((e, i) => (delays[i] === undefined ? e : { ...e, at: virtualEpoch + delays[i] })),
  };
  const r = new Run({
    chooser: replayChooser({ seed: 1, faults: [...faults] }),
    bounds: spec.bounds,
  });
  await runOnce(spec, platform, r);
  return r;
}

const flowOps = (r: Run): string[] =>
  r.log.entries
    .filter((e) => e.target === "Workflow:FLOW" && e.kind !== "snapshot" && e.kind !== "call")
    .map((e) => `${e.invocation} ${e.kind} ${e.op}`);
const results = (r: Run, op: string): EffectRecord[] =>
  r.log.entries.filter((e) => e.kind === "result" && e.op === op && e.target === "Workflow:FLOW");
type Row = { id: string; status: string; params: unknown; output?: unknown; error?: string };
const instances = (r: Run): Row[] => {
  const snap = [...r.log.entries]
    .reverse()
    .find((e) => e.kind === "snapshot" && e.target === "Workflow:FLOW");
  if (!snap) throw new Error("no Workflow snapshot");
  return (snap.payload as { tables: { instances: Row[] } }).tables.instances;
};
const start = (id: string, extra: { readonly [k: string]: JsonValue } = {}): HttpRequestInput => ({
  path: "/start",
  body: { id, ...extra },
});
/** The virtual times (ms after the epoch) the runs of an instance started at, each within the effect latency of a point. */
const runTimes = (id: string): number[] =>
  seen
    .filter((s) => s.startsWith(`run ${id} `))
    .map((s) => Number(s.slice(s.lastIndexOf(" ") + 1)));
const near = (expected: number[]) =>
  expect.arrayContaining(expected.map((t) => expect.closeTo(t, -1)));
const approve = (id: string, by = "alice", type = "approved"): HttpRequestInput => ({
  path: "/event",
  body: { id, type, payload: { by } },
});

describe("waiting for an event", () => {
  test("an event sent before the wait is buffered: the wait returns it at once and the instance completes", async () => {
    // Initial requests are delivered before the run they enqueue: the event is there when the wait starts.
    const r = await run(scenario([start("a-1"), approve("a-1")]));
    expect(instances(r)).toEqual([
      {
        id: "a-1",
        status: "complete",
        params: { id: "a-1" },
        output: { received: [{ type: "approved", by: "alice", at: expect.any(Number) }] },
      },
    ]);
    expect(results(r, "send_event")).toHaveLength(1);
    expect(results(r, "event")).toHaveLength(1);
    expect(results(r, "wait")).toHaveLength(0);
    expect(results(r, "wait_timeout")).toHaveLength(0);
  });

  test("a wait with no event suspends the instance; the event wakes it, and the stale timeout wake does nothing", async () => {
    // The approval comes 10 minutes after the start, in virtual time: the run has suspended by then.
    const r = await run(scenario([start("w-1"), approve("w-1")]), [], { 1: 600_000 });
    const ops = flowOps(r);
    expect(ops.filter((o) => o.endsWith("result wait"))).toEqual([
      "workflow:FLOW:w-1#1 result wait",
    ]);
    expect(ops.filter((o) => o.endsWith("result event"))).toEqual([
      "workflow:FLOW:w-1:event-1#1 result event",
    ]);
    expect(instances(r)[0]?.status).toBe("complete");
    // One run suspended, one resumed by the event at its time; no third run from the timeout wake.
    expect(runTimes("w-1")).toHaveLength(2);
    expect(runTimes("w-1")).toEqual(near([0, 600_000]));
  });

  test("two events of the waited type while waiting wake the instance once; the second stays buffered", async () => {
    const r = await run(
      scenario([start("m-1"), approve("m-1", "alice"), approve("m-1", "bob")]),
      [],
      { 1: 600_000, 2: 600_000 },
    );
    expect(results(r, "send_event")).toHaveLength(2);
    expect(results(r, "event")).toHaveLength(1);
    expect(instances(r)[0]).toMatchObject({
      status: "complete",
      output: { received: [{ type: "approved", by: "alice", at: expect.any(Number) }] },
    });
    expect(runTimes("m-1")).toHaveLength(2);
  });

  test("with no event the wait times out at its deadline, in virtual time, and the instance fails", async () => {
    const r = await run(scenario([start("t-1", { timeout: "1 hour" })]));
    const ops = flowOps(r);
    expect(ops).toContain("workflow:FLOW:t-1#1 result wait");
    expect(ops).toContain("workflow:FLOW:t-1:timeout-1#1 result wait_timeout");
    expect(ops).toContain("workflow:FLOW:t-1:timeout-1#1 result errored");
    expect(instances(r)[0]).toMatchObject({
      status: "errored",
      error: "WorkflowTimeoutError: Execution timed out after 3600000ms",
    });
    expect(runTimes("t-1")).toHaveLength(2);
    expect(runTimes("t-1")).toEqual(near([0, 3_600_000]));
  });

  test("the timeout error is catchable, and the wait's error is persisted like a step's", async () => {
    const r = await run(scenario([start("c-1", { timeout: "30 minutes", catchIt: true })]));
    expect(instances(r)[0]).toMatchObject({ status: "complete", output: { timedOut: true } });
    expect(seen).toContain("caught WorkflowTimeoutError: Execution timed out after 1800000ms");
  });

  test("two waits of different types take their events in either order; a wait is keyed by name and count", async () => {
    const r = await run(
      scenario([
        start("d-1", { waits: 2 }),
        approve("d-1", "bob", "signed"),
        approve("d-1", "alice"),
      ]),
    );
    const out = instances(r)[0]?.output as { received: { type: string; by: string }[] };
    expect(out.received.map((x) => [x.type, x.by])).toEqual([
      ["approved", "alice"],
      ["signed", "bob"],
    ]);
  });

  test("a restart after the wait returned replays the stored event: it is not consumed twice", async () => {
    const r = await run(scenario([start("p-1"), approve("p-1")]), [
      {
        invocation: "workflow:FLOW:p-1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    // Effects of the run: 0 the event received, 1 the notify step's start, crashed; the restart replays.
    expect(flowOps(r)).toContain("workflow:FLOW:p-1#1 fault step");
    expect(instances(r)[0]?.status).toBe("complete");
    expect(results(r, "event")).toHaveLength(1);
    expect(seen.filter((s) => s.startsWith("run p-1"))).toHaveLength(2);
  });

  test("a crash in the run an event woke is restarted like any other, not dropped as a stale wake", async () => {
    const r = await run(
      scenario([start("k-1"), approve("k-1")]),
      [
        {
          invocation: "workflow:FLOW:k-1:event-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Workflow:FLOW",
          op: "step",
        },
      ],
      { 1: 600_000 },
    );
    expect(flowOps(r)).toContain("workflow:FLOW:k-1:event-1#1 fault step");
    expect(flowOps(r)).toContain("workflow:FLOW:k-1:event-1#2 result complete");
    expect(instances(r)[0]?.status).toBe("complete");
  });

  test("a persisted timeout error keeps its name on replay: two waits caught by name both complete", async () => {
    const r = await run(scenario([start("n-1", { twoTimeouts: true })]));
    expect(instances(r)[0]).toMatchObject({
      status: "complete",
      output: { names: ["WorkflowTimeoutError", "WorkflowTimeoutError"] },
    });
    expect(results(r, "wait_timeout")).toHaveLength(2);
  });

  test("an event sent after the wait's deadline does not satisfy it, even when the timeout wake was held up", async () => {
    // The approval handler starts before the deadline and sleeps past it, holding the only slot.
    const late = {
      path: "/event",
      body: { id: "l-1", type: "approved", payload: { by: "late" }, delayMs: 120_000 },
    };
    const r = await run(scenario([start("l-1", { timeout: "1 minute" }), late]), [], { 1: 500 });
    expect(results(r, "send_event")).toHaveLength(1);
    expect(results(r, "event")).toHaveLength(0);
    expect(instances(r)[0]).toMatchObject({
      status: "errored",
      error: "WorkflowTimeoutError: Execution timed out after 60000ms",
    });
  });

  test("code that catches the suspension and goes on is not modelled", async () => {
    const r = await run(scenario([start("s-1", { swallow: true })]));
    expect(r.unsupportedReasons.join("\n")).toContain(
      "after step.waitForEvent suspended the instance",
    );
  });
});

describe("sending an event", () => {
  test("an invalid type, an unknown instance and a finished instance are refused as the binding refuses them", async () => {
    const r = await run(
      scenario([
        start("e-1"),
        approve("e-1"),
        { path: "/event", body: { id: "e-1", type: "approved.again", payload: {} } },
        { path: "/event", body: { id: "nobody", type: "approved", payload: {} } },
        approve("e-1", "late"),
      ]),
      [],
      // The late approval comes an hour later, once the instance has completed.
      { 4: 3_600_000 },
    );
    const answers = r.log.entries
      .filter((e) => e.kind === "result" && e.op === "response")
      .map((e) => (e.payload as { result: { status: number; body: string } }).result)
      .slice(2);
    expect(answers.map((a) => a.status)).toEqual([409, 409, 409]);
    expect(answers[0]?.body).toContain("workflow.invalid_event_type");
    expect(answers[1]?.body).toContain("instance.not_found");
    expect(answers[2]?.body).toContain("instance.not_running");
  });

  test("the event is a copy with the virtual time it was sent, and the send is recorded", async () => {
    const r = await run(scenario([start("v-1"), approve("v-1")]));
    const out = instances(r)[0]?.output as { received: { at: number }[] };
    expect(out.received[0]?.at).toBeGreaterThanOrEqual(0);
    expect(results(r, "send_event")[0]?.payload).toEqual({
      args: { id: "v-1", type: "approved", payload: { by: "alice" } },
      result: null,
    });
  });
});
