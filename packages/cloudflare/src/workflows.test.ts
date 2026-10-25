/**
 * The Workflows model in Node: instances created through the binding run as
 * their own invocations; steps persist their results, retry in virtual time,
 * and run again only when the engine restarted before persisting them. The
 * class runs against the model with the real local engine never called; the
 * corpus checks the model against that engine inside workerd.
 */
import type { EffectRecord, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { explore, Run, runOnce, virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { defineScenario, external, fetchCall, http, workflow, workflowRows } from "./scenario.ts";
import {
  constructWorkflow,
  deliverWorkflow,
  durationMs,
  type Instance,
  proxyWorkflow,
  validStepConfig,
  WorkflowRegistry,
} from "./workflows.ts";

/** workerd's base refuses to be constructed outside the runtime; this one refuses always. */
class WorkflowEntrypoint {
  readonly env: unknown;
  constructor() {
    throw new TypeError("Failed to construct 'WorkflowEntrypoint'");
  }
}

type Step = {
  do(name: string, a: unknown, b?: unknown, c?: unknown): Promise<unknown>;
  sleep(name: string, d: unknown): Promise<void>;
  sleepUntil(name: string, t: unknown): Promise<void>;
  waitForEvent(name: string, o: unknown): Promise<unknown>;
};
type FlowEnv = { readonly FLOW: { create(o: unknown): Promise<{ id: string }> } };

/** Code outside steps that ran, per instance: it repeats after a restart. */
let outside: string[] = [];
/** Per step name, attempts that should throw before succeeding. */
let failFirst: Record<string, number> = {};

/** Generates a reply, then posts it; the post is not idempotent unless the API dedupes. */
class ReplyFlow extends WorkflowEntrypoint {
  readonly label = "reply-flow";
  async run(event: { payload: { messageId: string }; instanceId: string }, step: Step) {
    outside.push(event.instanceId);
    const text = await step.do("generate", async () => `re: ${event.payload.messageId}`);
    const sent = await step.do(
      "post reply",
      { retries: { limit: 2, delay: "30 seconds", backoff: "constant" } },
      async (ctx: { attempt: number }) => {
        if ((failFirst["post reply"] ?? 0) >= ctx.attempt) throw new Error("chat API down");
        const r = await fetch("https://chat.example/reply", {
          method: "POST",
          headers: { "idempotency-key": event.payload.messageId },
          body: JSON.stringify({ messageId: event.payload.messageId, text }),
        });
        return r.status;
      },
    );
    return { sent, label: this.label };
  }
}

class SleepyFlow extends WorkflowEntrypoint {
  async run(event: { instanceId: string }, step: Step) {
    outside.push(`${event.instanceId}@${Date.now() - virtualEpoch}`);
    await step.sleep("wait", "1 hour");
    return step.do("after", async () => Date.now() - virtualEpoch);
  }
}

/** A step that waits on its own timer, and one whose partial retry config keeps the default backoff. */
class TimingFlow extends WorkflowEntrypoint {
  async run(_e: unknown, step: Step) {
    const waited = await step.do("wait inside", async () => {
      const t = Date.now();
      await new Promise((r) => setTimeout(r, 30_000));
      return Date.now() - t;
    });
    const starts: number[] = [];
    await step.do("flaky", { retries: { limit: 3, delay: "10 seconds" } }, async () => {
      starts.push(Date.now());
      if (starts.length < 3) throw new Error("not yet");
    });
    const [a = 0, b = 0, c = 0] = starts;
    return { waited, gaps: [b - a, c - b] };
  }
}

/** What a step's callback sees: its attempt across restarts, and its config without a delay function. */
class ContextFlow extends WorkflowEntrypoint {
  async run(_e: unknown, step: Step) {
    const attempt = await step.do("attempt", async (ctx: { attempt: number }) => ctx.attempt);
    const starts: number[] = [];
    const config = await step.do(
      "dynamic",
      { retries: { limit: 3, delay: () => 1000, backoff: "exponential" } },
      async (ctx: { config: unknown }) => {
        starts.push(Date.now());
        if (starts.length < 3) throw new Error("not yet");
        return ctx.config;
      },
    );
    const [a = 0, b = 0, c = 0] = starts;
    return { attempt, config, gaps: [b - a, c - b] };
  }
}

/** Reads the payload a bare create() gave it, sleeps until a past time, then returns a stream. */
class EdgeFlow extends WorkflowEntrypoint {
  async run(
    event: { payload: unknown },
    step: Step & { sleepUntil(n: string, t: unknown): Promise<void> },
  ) {
    const payload = event.payload;
    let past = "";
    try {
      await step.sleepUntil("expired", Date.now() - 1000);
    } catch (err) {
      past = String(err);
    }
    if ((payload as { stream?: boolean } | null)?.stream)
      await step.do("stream", async () => new ReadableStream());
    return { payload, past };
  }
}

/** A sleep beside a slow step; a step whose retry limit is computed outside it, per run. */
let runsOfPersisting = 0;
let staleCalls = 0;
let fatalRuns = 0;
let badConfigRan = false;
let siblingRuns = 0;
let siblingTicks = 0;
class PersistingFlow extends WorkflowEntrypoint {
  async run(event: { payload: { case: string }; timestamp: Date }, step: Step) {
    if (event.payload.case === "sleep") {
      await Promise.all([
        step.sleep("beside", "10 seconds"),
        step.do("slow", async () => {
          await new Promise((r) => setTimeout(r, 5000));
        }),
      ]);
      return { elapsed: Date.now() - event.timestamp.getTime() };
    }
    if (event.payload.case === "retry") {
      const [retriedAt] = await Promise.all([
        step.do(
          "waits to retry",
          { retries: { limit: 1, delay: "10 seconds" } },
          async (ctx: { attempt: number }) => {
            if (ctx.attempt === 1) throw new Error("first attempt fails");
            return Date.now() - event.timestamp.getTime();
          },
        ),
        step.do("crashes", async () => {
          await new Promise((r) => setTimeout(r, 5000));
        }),
      ]);
      return { retriedAt };
    }
    if (event.payload.case === "durations") {
      // A sleep whose duration changes on the restart is a different sleep, as in the engine.
      runsOfPersisting++;
      await step.sleep("pause", runsOfPersisting === 1 ? "1 second" : "2 seconds");
      await step.do("after pause", async () => null);
      const until = event.timestamp.getTime() + 60_000;
      await step.sleepUntil("deadline", until);
      await step.do("after deadline", async () => null);
      return { elapsed: Date.now() - event.timestamp.getTime() };
    }
    if (event.payload.case === "timeout") {
      runsOfPersisting++;
      const timeout = runsOfPersisting === 1 ? "1 minute" : "2 minutes";
      return step.do(
        "timed",
        { timeout },
        async (ctx: { attempt: number; config: { timeout: unknown } }) => {
          if (ctx.attempt < 2) throw new Error("first attempt fails");
          return ctx.config.timeout;
        },
      );
    }
    if (event.payload.case === "caught fatal") {
      try {
        await step.do("fatal", async () => {
          fatalRuns++;
          throw Object.assign(new Error("stop"), { name: "NonRetryableError" });
        });
      } catch {
        // recovered
      }
      await step.do("after", async () => null);
      return { fatalRuns };
    }
    if (event.payload.case === "bad delay") {
      await step
        .do(
          "bad delay",
          {
            retries: {
              limit: 1,
              delay: () => {
                throw new Error("no delay");
              },
            },
          },
          async () => {
            throw new Error("fails");
          },
        )
        .catch(() => null);
      return null;
    }
    if (event.payload.case === "bad config") {
      await step
        .do("zero timeout", { timeout: 0 }, async () => {
          badConfigRan = true;
        })
        .catch(() => null);
      return null;
    }
    if (event.payload.case === "mutated config") {
      const starts: number[] = [];
      await step.do(
        "mutates",
        { retries: { limit: 1, delay: 1000, backoff: "constant" } },
        async (ctx: { config: { retries: { delay: number } } }) => {
          starts.push(Date.now());
          ctx.config.retries.delay = 30_000;
          if (starts.length < 2) throw new Error("first attempt fails");
        },
      );
      const [a = 0, b = 0] = starts;
      return { gap: b - a };
    }
    if (event.payload.case === "error names") {
      const caught = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return null;
        } catch (err) {
          return { name: (err as Error).name, message: (err as Error).message };
        }
      };
      let prefixed = 0;
      let objectNamed = 0;
      const byMessage = await caught(() =>
        step.do("by message", { retries: { limit: 2, delay: 1 } }, async () => {
          prefixed++;
          throw new Error("NonRetryableError: stop");
        }),
      );
      await caught(() =>
        step.do("plain object", { retries: { limit: 1, delay: 1 } }, async () => {
          objectNamed++;
          throw { name: "NonRetryableError" };
        }),
      );
      const timeout = await caught(() =>
        step.do(
          "times out",
          { retries: { limit: 0, delay: 1 }, timeout: "30 seconds" },
          async () => null,
        ),
      );
      return { byMessage, prefixed, objectNamed, timeout };
    }
    if (event.payload.case === "sensitive") {
      return step.do(
        "secret",
        { sensitive: "output" },
        async (ctx: { config: { sensitive?: string } }) => ({
          sensitive: ctx.config.sensitive ?? null,
          token: "s3cr3t",
        }),
      );
    }
    if (event.payload.case === "too large") {
      await step.do("big", async () => "x".repeat(2 * 1024 * 1024)).catch(() => null);
      return null;
    }
    if (event.payload.case === "big buffer") {
      await step.do("buffer", async () => new ArrayBuffer(2 * 1024 * 1024)).catch(() => null);
      return null;
    }
    if (event.payload.case === "mutated context") {
      let seen = 0;
      await step.do(
        "mutates context",
        {
          retries: {
            limit: 1,
            delay: ({ ctx }: { ctx: { attempt: number } }) => {
              seen = ctx.attempt;
              return 1;
            },
          },
        },
        async (ctx: { attempt: number }) => {
          if (ctx.attempt === 1) {
            ctx.attempt = 99;
            throw new Error("first attempt fails");
          }
        },
      );
      return { seen };
    }
    if (event.payload.case === "sibling throws after crash") {
      await Promise.all([
        step.do("crashes", async () => "a"),
        step
          .do("throws later", { retries: { limit: 0, delay: 1 } }, async () => {
            siblingRuns++;
            for (let i = 0; i < siblingTicks; i++) await Promise.resolve();
            throw new Error("sibling fails");
          })
          .catch(() => "caught"),
      ]);
      return { siblingRuns };
    }
    if (event.payload.case === "plain throw") {
      try {
        await step.do("declines", { retries: { limit: 0, delay: 1 } }, async () => {
          throw { code: "DECLINED" };
        });
      } catch (err) {
        return { code: (err as { code?: string }).code ?? null };
      }
    }
    if (event.payload.case === "typed") {
      let typed = false;
      try {
        await step.do("typed", { retries: { limit: 0, delay: 1 } }, async () => {
          throw new TypeError("typed failure");
        });
      } catch (err) {
        typed = err instanceof TypeError;
      }
      await step.do("after", async () => null);
      return { typed };
    }
    if (event.payload.case === "stale delay") {
      runsOfPersisting++;
      const first = runsOfPersisting === 1;
      return step.do(
        "retried",
        {
          retries: {
            limit: 2,
            delay: first
              ? () => {
                  staleCalls++;
                  return 1000;
                }
              : 5000,
            backoff: "constant",
          },
        },
        async (ctx: { attempt: number }) => {
          if (ctx.attempt < 3) throw new Error("fails twice");
          return Date.now() - event.timestamp.getTime();
        },
      );
    }
    runsOfPersisting++;
    const limit = runsOfPersisting === 1 ? 2 : 0;
    return step.do(
      "configured",
      { retries: { limit, delay: 1000 } },
      async (ctx: { attempt: number }) => {
        if (ctx.attempt < 2) throw new Error("first attempt fails");
        return ctx.attempt;
      },
    );
  }
}

/** Returns output deeper than the trace keeps, then (on request) runs a step with a bad name. */
class DeepFlow extends WorkflowEntrypoint {
  async run(event: { payload: { badName?: boolean; returns?: string } }, step: Step) {
    if (event.payload.returns === "function") return () => 1;
    if (event.payload.returns === "type-error") throw new TypeError("bad input");
    if (event.payload.badName) {
      await step.do("bad\u0001name", async () => {
        ran = true;
      });
    }
    let deep: unknown = "leaf";
    for (let i = 0; i < 15; i++) deep = { deep };
    return deep;
  }
}
let ran = false;

/** Two pure steps: no effects of their own, so only the engine's persisting can give way to others. */
class PureFlow extends WorkflowEntrypoint {
  async run(_e: unknown, step: Step) {
    await step.do("one", async () => 1);
    await step.do("two", async () => 2);
    return "done";
  }
}

class NamedFlow extends WorkflowEntrypoint {
  async run(event: { workflowName?: string }) {
    return { name: event.workflowName ?? null };
  }
}

class GiveUpFlow extends WorkflowEntrypoint {
  async run(_e: unknown, step: Step) {
    await step.do("fatal", async () => {
      const e = new Error("bad input");
      e.name = "NonRetryableError";
      throw e;
    });
  }
}

class WaitingFlow extends WorkflowEntrypoint {
  async run(_e: unknown, step: Step) {
    await step.waitForEvent("approval", { type: "approved" });
  }
}

/** Starts one instance per message, keyed by the message id; a duplicate create is caught. */
const webhook: WorkerHandler = {
  async fetch(request, env) {
    const { messageId, bare, stream, persisting, invalid } = (await request.json()) as {
      messageId: string;
      bare?: boolean;
      stream?: boolean;
      persisting?: string;
      invalid?: boolean;
    };
    if (invalid) {
      try {
        await (env as FlowEnv).FLOW.create({ id: "customer@example.com" });
      } catch (err) {
        await (env as FlowEnv).FLOW.create({ id: "null-params", params: null });
        return new Response(String(err));
      }
      return new Response("created");
    }
    if (persisting) {
      await (env as FlowEnv).FLOW.create({ id: "p1", params: { case: persisting } });
      return new Response("ok");
    }
    if (bare) {
      await (env as FlowEnv).FLOW.create(stream ? { params: { stream } } : {});
      return new Response("ok");
    }
    try {
      await (env as FlowEnv).FLOW.create({ id: messageId, params: { messageId } });
    } catch (err) {
      if (!String(err).includes("instance.already_exists")) throw err;
    }
    return new Response("ok");
  },
};

/** The real binding's shape; any call on it would mean the model leaked to the engine. */
const realBinding = {
  create: () => {
    throw new Error("the real engine was called");
  },
  createBatch: () => {
    throw new Error("the real engine was called");
  },
  get: () => {
    throw new Error("the real engine was called");
  },
};

function scenario(
  cls: string,
  options: { dedupe?: boolean; messages?: string[]; retries?: number; body?: object } = {},
): ScenarioSpec {
  return defineScenario({
    name: `workflow-${cls.toLowerCase()}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: http(
      (options.messages ?? ["m1"]).map((id) => ({
        path: "/webhook",
        body: { messageId: id, ...options.body },
      })),
      { retries: options.retries ?? 0 },
    ),
    setup: [workflow("FLOW", cls)],
    externals: [
      external("chat", "chat.example", {
        ...(options.dedupe ? { dedupeBy: "idempotency-key" } : {}),
        responses: [{ status: 200 }],
      }),
    ],
    invariants: [
      {
        kind: "atMostOncePerKey",
        name: "one-reply-per-message",
        effect: fetchCall("chat", "POST"),
        key: "args.dedupeKey",
      },
      { kind: "unique", name: "one-run-per-message", query: workflowRows("FLOW"), path: "id" },
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1 },
  });
}

const platform = () =>
  createCloudflarePlatform({
    env: { FLOW: realBinding },
    handler: webhook,
    schemas: {},
    exports: {
      ReplyFlow,
      SleepyFlow,
      GiveUpFlow,
      WaitingFlow,
      TimingFlow,
      NamedFlow,
      ContextFlow,
      EdgeFlow,
      PersistingFlow,
      DeepFlow,
      PureFlow,
    },
  });

async function run(spec: ScenarioSpec, faults: Run["schedule"]["faults"] = []) {
  outside = [];
  const r = new Run({
    mode: "replay",
    schedule: { seed: 1, faults: [...faults] },
    bounds: spec.bounds,
    faultProbability: 0,
  });
  await runOnce(spec, platform(), r);
  return r;
}

const of = (r: Run, op: string): EffectRecord[] =>
  r.log.entries.filter(
    (e) => e.kind === "result" && e.op === op && e.target.startsWith("Workflow:"),
  );
const posts = (r: Run): EffectRecord[] =>
  r.log.entries.filter((e) => e.kind === "result" && e.target === "Fetch:chat");
const instances = (r: Run) => {
  const snap = [...r.log.entries]
    .reverse()
    .find((e) => e.kind === "snapshot" && e.target === "Workflow:FLOW");
  if (!snap) throw new Error("no Workflow snapshot");
  return (
    snap.payload as { tables: { instances: { id: string; status: string; output?: unknown }[] } }
  ).tables.instances;
};

describe("constructWorkflow", () => {
  test("runs the class's own initialisers with ctx and env, and puts its base back", () => {
    const flow = constructWorkflow(ReplyFlow, { waitUntil() {} }, { MARK: 1 }) as ReplyFlow;
    expect(flow.label).toBe("reply-flow");
    expect(flow.env).toEqual({ MARK: 1 });
    expect(flow).toBeInstanceOf(ReplyFlow);
    expect(Object.getPrototypeOf(ReplyFlow)).toBe(WorkflowEntrypoint);
    expect(() => new ReplyFlow()).toThrow(/Failed to construct/);
  });

  test("refuses a class that does not extend WorkflowEntrypoint", () => {
    expect(() => constructWorkflow(class Plain {}, {}, {})).toThrow(/does not extend/);
  });
});

describe("durationMs", () => {
  test("reads milliseconds and Workflows duration strings", () => {
    expect(durationMs(250)).toBe(250);
    expect(durationMs("30 seconds")).toBe(30_000);
    expect(durationMs("1 minute")).toBe(60_000);
    expect(durationMs("2 hours")).toBe(7_200_000);
    expect(() => durationMs("soon")).toThrow(/not a Workflows duration/);
    // As the engine converts them: a year is 365.25 days, a numeric string is milliseconds.
    expect(durationMs("1 year")).toBe(31_557_600_000);
    expect(durationMs("5000")).toBe(5000);
    expect(durationMs("500 ms")).toBe(500);
  });
});

describe("a Workflow started from a webhook", () => {
  test("runs as its own invocation, persists its steps and completes; the real engine is never called", async () => {
    const r = await run(scenario("ReplyFlow"));
    expect(r.unsupportedReasons).toEqual([]);
    expect(of(r, "create").map((e) => e.payload)).toMatchObject([{ args: { id: "m1" } }]);
    expect(of(r, "step").map((e) => (e.payload as { args: { step: string } }).args.step)).toEqual([
      "generate",
      "post reply",
    ]);
    expect(posts(r)).toHaveLength(1);
    expect(instances(r)).toEqual([
      {
        id: "m1",
        status: "complete",
        params: { messageId: "m1" },
        output: { sent: 200, label: "reply-flow" },
      },
    ]);
    // The instance's effects are its own invocation's, not the webhook's.
    expect(new Set(of(r, "step").map((e) => e.invocation))).toEqual(
      new Set(["workflow:FLOW:m1#1"]),
    );
  });

  test("a step whose result was not persisted runs again after the restart: two replies", async () => {
    const r = await run(scenario("ReplyFlow"), [
      {
        invocation: "workflow:FLOW:m1#1",
        ordinal: 4,
        fault: "crash_after",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    expect(posts(r)).toHaveLength(2);
    // The restart replayed "generate" from its persisted result and re-ran only the reply.
    expect(of(r, "step").map((e) => (e.payload as { args: { step: string } }).args.step)).toEqual([
      "generate",
      "post reply",
      "post reply",
    ]);
    expect(outside).toEqual(["m1", "m1"]);
    expect(instances(r)[0]?.status).toBe("complete");
  });

  test("a restart before a step repeats the code outside steps but not the persisted steps", async () => {
    const r = await run(scenario("ReplyFlow"), [
      {
        invocation: "workflow:FLOW:m1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(outside).toEqual(["m1", "m1"]);
    expect(of(r, "step").map((e) => (e.payload as { args: { step: string } }).args.step)).toEqual([
      "generate",
      "post reply",
    ]);
    expect(posts(r)).toHaveLength(1);
  });

  test("an attempt that ran but counted as failed is retried after its delay: two replies", async () => {
    const r = await run(scenario("ReplyFlow"), [
      {
        invocation: "workflow:FLOW:m1#1",
        ordinal: 4,
        fault: "ambiguous",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    expect(posts(r)).toHaveLength(2);
    const attempts = of(r, "step").filter(
      (e) => (e.payload as { args: { step: string } }).args.step === "post reply",
    );
    expect(attempts.map((e) => (e.payload as { args: { attempt: number } }).args.attempt)).toEqual([
      1, 2,
    ]);
    expect(outside).toEqual(["m1"]);
  });

  test("exploration finds the duplicate reply, and an API that dedupes holds", async () => {
    const buggy = await explore(scenario("ReplyFlow"), platform(), {
      seed: 3,
      leakCheckRuns: 0,
      maxRuns: 60,
    });
    expect(buggy.kind).toBe("VIOLATED");
    if (buggy.kind === "VIOLATED") expect(buggy.violation.invariant).toBe("one-reply-per-message");
    const fixed = await explore(scenario("ReplyFlow", { dedupe: true }), platform(), {
      seed: 3,
      leakCheckRuns: 0,
      maxRuns: 60,
    });
    expect(fixed.kind).toBe("BOUNDED");
  });

  test("a failing step is retried in virtual time, up to its limit", async () => {
    failFirst = { "post reply": 1 };
    try {
      const r = await run(scenario("ReplyFlow"));
      const attempts = of(r, "step_result").filter(
        (e) => (e.payload as { args: { step: string } }).args.step === "post reply",
      );
      expect(attempts).toHaveLength(2);
      expect((attempts[0]?.payload as { error?: string } | undefined)?.error).toContain(
        "chat API down",
      );
      expect(instances(r)[0]?.status).toBe("complete");
      failFirst = { "post reply": 5 };
      const out = await run(scenario("ReplyFlow"));
      // limit 2: three attempts, then the error reaches run() and the instance errors.
      expect(
        of(out, "step").filter(
          (e) => (e.payload as { args: { step: string } }).args.step === "post reply",
        ),
      ).toHaveLength(3);
      expect(instances(out)[0]?.status).toBe("errored");
    } finally {
      failFirst = {};
    }
  });

  test("a NonRetryableError is not retried", async () => {
    const r = await run(scenario("GiveUpFlow"));
    expect(of(r, "step")).toHaveLength(1);
    expect(instances(r)[0]?.status).toBe("errored");
  });

  test("a resent webhook creates no second instance when the id is the message's", async () => {
    const r = await run(scenario("ReplyFlow", { retries: 1 }), [
      {
        invocation: "req-1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Http:/webhook",
        op: "response",
      },
    ]);
    expect(of(r, "create")).toHaveLength(2);
    expect((of(r, "create")[1]?.payload as { error?: string } | undefined)?.error).toContain(
      "instance.already_exists",
    );
    expect(instances(r)).toHaveLength(1);
  });

  test("a sleep waits in virtual time and is not repeated after a restart", async () => {
    const r = await run(scenario("SleepyFlow"), [
      {
        invocation: "workflow:FLOW:m1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(outside).toHaveLength(2);
    // The restart came after the hour had passed, and did not sleep again.
    const [first, second] = outside.map((o) => Number(o.split("@")[1]));
    expect((second as number) - (first as number)).toBeGreaterThanOrEqual(3_600_000);
    expect(of(r, "sleep")).toHaveLength(1);
    expect(instances(r)[0]?.status).toBe("complete");
  });

  test("a step's own timers are virtual, and a partial retry config keeps the default backoff", async () => {
    const r = await run(scenario("TimingFlow"));
    expect(r.unsupportedReasons).toEqual([]);
    const output = instances(r)[0]?.output as { waited: number; gaps: number[] };
    expect(output.waited).toBeGreaterThanOrEqual(30_000);
    // 10 s, then 20 s: exponential, the default the config did not override.
    expect(output.gaps.map((g) => Math.round(g / 1000))).toEqual([10, 20]);
  });

  test("a step's attempt survives a restart; a delay function gets the backoff and is not in ctx.config", async () => {
    const r = await run(scenario("ContextFlow"), [
      {
        invocation: "workflow:FLOW:m1#1",
        ordinal: 1,
        fault: "crash_after",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    const output = instances(r)[0]?.output as { attempt: number; config: unknown; gaps: number[] };
    // The first attempt ran before the restart, so the one after it is the second.
    expect(output.attempt).toBe(2);
    expect(output.config).toEqual({
      retries: { limit: 3, backoff: "exponential" },
      timeout: "10 minutes",
    });
    // 1 s from the function, doubled for the second retry (each effect adds 1 ms of virtual time).
    expect(output.gaps.map((g) => Math.round(g / 1000))).toEqual([1, 2]);
  });

  test("a bare create() gives an empty payload, and sleepUntil a past time throws", async () => {
    const r = await run(scenario("EdgeFlow", { body: { bare: true } }));
    expect(r.unsupportedReasons).toEqual([]);
    expect(instances(r)[0]?.output).toEqual({
      payload: {},
      past: "Error: You can't sleep until a time in the past, time-traveler",
    });
  });

  test("an invalid id is refused as the binding refuses it, and an explicit null payload stays null", async () => {
    const r = await run(scenario("EdgeFlow", { body: { invalid: true } }));
    const creates = of(r, "create");
    expect((creates[0]?.payload as { error?: string } | undefined)?.error).toContain(
      "Workflow instance has invalid id",
    );
    expect(
      instances(r).map((i) => [i.id, (i.output as { payload: unknown } | undefined)?.payload]),
    ).toEqual([["null-params", null]]);
  });

  test("instance methods that are not modelled are UNSUPPORTED, not a TypeError", async () => {
    for (const method of ["delete", "subscribe"] as const) {
      const flowEnv = { FLOW: realBinding };
      const handler: WorkerHandler = {
        async fetch(_request, env) {
          const instance = (await (env as FlowEnv).FLOW.create({ id: "h1" })) as unknown as Record<
            string,
            () => unknown
          >;
          try {
            await instance[method]?.();
          } catch {
            // the run is UNSUPPORTED either way
          }
          return new Response("ok");
        },
      };
      const r = new Run({
        mode: "replay",
        schedule: { seed: 1, faults: [] },
        bounds: scenario("ReplyFlow").bounds,
        faultProbability: 0,
      });
      await runOnce(
        scenario("ReplyFlow"),
        createCloudflarePlatform({ env: flowEnv, handler, schemas: {}, exports: { ReplyFlow } }),
        r,
      );
      expect(r.unsupportedReasons.join()).toContain(`${method}() is not modelled`);
    }
  });

  test("status() returns a copy of the output, which the caller cannot change", async () => {
    const registry = new WorkflowRegistry();
    registry.instances.set("s1", {
      id: "s1",
      params: {},
      createdAt: 0,
      status: "complete",
      output: { label: "kept" },
      persisted: new Map(),
      attempts: new Map(),
      configs: new Map(),
      deadlines: new Map(),
    });
    const hooks = {
      effect: (_p: unknown, perform: () => Promise<unknown>) => perform(),
    } as unknown as RunHooks;
    const flow = proxyWorkflow("FLOW", { hooks, currentInvocation: () => "i" }, registry) as {
      get(id: string): Promise<{ status(): Promise<{ output: { label: string } }> }>;
    };
    registry.instances.set("q1", {
      ...(registry.instances.get("s1") as Instance),
      id: "q1",
      status: "queued",
      output: undefined,
    });
    expect((await (await flow.get("q1")).status()).output).toBeNull();
    const handle = await flow.get("s1");
    (await handle.status()).output.label = "changed by the caller";
    expect((await handle.status()).output.label).toBe("kept");
    expect(registry.rows().find((row) => (row as { id: string }).id === "s1")).toMatchObject({
      output: { label: "kept" },
    });
  });

  test("the output is kept as returned, beyond what the trace shows; a bad step name is refused", async () => {
    const instance = (badName: boolean) => ({
      id: "d1",
      params: { badName } as unknown,
      createdAt: 0,
      status: "queued" as const,
      persisted: new Map(),
      attempts: new Map(),
      configs: new Map(),
      deadlines: new Map(),
    });
    const deliver = async (i: ReturnType<typeof instance>) => {
      const r = new Run({
        mode: "replay",
        schedule: { seed: 1, faults: [] },
        bounds: scenario("DeepFlow").bounds,
        faultProbability: 0,
      });
      const event = {
        id: "workflow:FLOW:d1",
        attempt: 1,
        source: "workflow",
        data: { binding: "FLOW", id: "d1" },
      };
      await deliverWorkflow(event, r, {
        binding: "FLOW",
        instance: i,
        cls: DeepFlow,
        env: {},
        maxFaultsPerRun: 0,
        maxRedeliveries: 0,
      });
      return r;
    };
    const kept = instance(false);
    await deliver(kept);
    let depth = 0;
    let v = (kept as { output?: unknown }).output;
    while (typeof v === "object" && v !== null && "deep" in v) {
      v = (v as { deep: unknown }).deep;
      depth++;
    }
    expect([depth, v]).toEqual([15, "leaf"]);
    ran = false;
    const bad = await deliver(instance(true));
    expect(ran).toBe(false);
    expect(bad.unsupportedReasons.join()).toContain(
      "exceeds max length (256 chars) or invalid characters",
    );
    // A result the engine cannot keep fails the instance, inside the run, and is reported.
    const fn = { ...instance(false), params: { returns: "function" } };
    const r = await deliver(fn);
    expect(fn.status).toBe("errored");
    expect(r.unsupportedReasons.join()).toContain("not structured-cloneable");
    // status() keeps the error's name and message apart, as the binding does.
    const failed = { ...instance(false), params: { returns: "type-error" } };
    await deliver(failed);
    const registry = new WorkflowRegistry();
    registry.instances.set("d1", failed);
    const hooks = {
      effect: (_p: unknown, perform: () => Promise<unknown>) => perform(),
    } as unknown as RunHooks;
    const flow = proxyWorkflow("FLOW", { hooks, currentInvocation: () => "i" }, registry) as {
      get(id: string): Promise<{ status(): Promise<{ error?: unknown }> }>;
    };
    expect((await (await flow.get("d1")).status()).error).toEqual({
      name: "TypeError",
      message: "bad input",
    });
  });

  test("a step that returns a stream is UNSUPPORTED, not a failure to retry", async () => {
    const r = await run(scenario("EdgeFlow", { body: { bare: true, stream: true } }));
    expect(r.unsupportedReasons.join()).toContain("not structured-cloneable");
    expect(
      of(r, "step").filter((e) => (e.payload as { args: { step: string } }).args.step === "stream"),
    ).toHaveLength(1);
  });

  test("a pending sleep's deadline and a step's config survive a restart", async () => {
    // The slow step crashes after 5 s; the sleep beside it resumes, ending 10 s from the start.
    const slept = await run(scenario("PersistingFlow", { body: { persisting: "sleep" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_after",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    const { elapsed } = (instances(slept)[0]?.output ?? { elapsed: -1 }) as { elapsed: number };
    expect(Math.round(elapsed / 1000)).toBe(10);
    // A retry waiting beside a step that crashes at 5 s still waits out its 10 s after the restart.
    const retried = await run(scenario("PersistingFlow", { body: { persisting: "retry" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 3,
        fault: "crash_after",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    const { retriedAt } = (instances(retried)[0]?.output ?? { retriedAt: -1 }) as {
      retriedAt: number;
    };
    expect(Math.round(retriedAt / 1000)).toBe(10);
    // The second run's sleep has another duration, so it sleeps; the finished sleepUntil is not re-run.
    runsOfPersisting = 0;
    const durations = await run(scenario("PersistingFlow", { body: { persisting: "durations" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 5,
        fault: "crash_after",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    // The finished sleepUntil replays after its time: where the local engine throws, it is UNSUPPORTED.
    expect(durations.unsupportedReasons.join()).toContain("sleepUntil");
    const sleeps = of(durations, "sleep").map(
      (e) => (e.payload as { args: { ms: number } }).args.ms,
    );
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBeGreaterThan(58_000);
    expect(sleeps[2]).toBe(2000);
    expect(instances(durations)[0]?.status).toBe("complete");
    // The config's timeout is the first attempt's too.
    runsOfPersisting = 0;
    const timed = await run(scenario("PersistingFlow", { body: { persisting: "timeout" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(instances(timed)[0]?.output).toBe("1 minute");
    // A NonRetryableError is not persisted: after a restart its callback runs again, as in the engine.
    fatalRuns = 0;
    await run(scenario("PersistingFlow", { body: { persisting: "caught fatal" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(fatalRuns).toBe(2);
    // A delay function that throws is not modelled.
    const badDelay = await run(scenario("PersistingFlow", { body: { persisting: "bad delay" } }));
    expect(badDelay.unsupportedReasons.join()).toContain("delay function threw");
    // The engine's schema, exactly: a "0" timeout, unknown fields and a wrong sensitive are rejected.
    for (const bad of [
      { timeout: "0" },
      { retry: { limit: 1 } },
      { sensitive: "all" },
      { retries: { limit: 1, delay: 1, jitter: true } },
    ])
      expect(validStepConfig(bad as never), JSON.stringify(bad)).toBe(false);
    expect(
      validStepConfig({
        retries: { limit: 0, delay: "5 seconds" },
        timeout: 1000,
        sensitive: "output",
      }),
    ).toBe(true);
    // A config the engine rejects is its fatal error, before the callback runs.
    badConfigRan = false;
    const badConfig = await run(scenario("PersistingFlow", { body: { persisting: "bad config" } }));
    expect(badConfigRan).toBe(false);
    expect(badConfig.unsupportedReasons.join()).toContain("invalid format");
    // The callback's copy of the config is its own: changing it does not change the retry.
    const mutated = await run(
      scenario("PersistingFlow", { body: { persisting: "mutated config" } }),
    );
    const { gap } = (instances(mutated)[0]?.output ?? { gap: -1 }) as { gap: number };
    expect(Math.round(gap / 1000)).toBe(1);
    // The engine's own error predicates and names: a NonRetryableError by message too (an Error only),
    // and a timed-out attempt as WorkflowTimeoutError.
    const names = await run(scenario("PersistingFlow", { body: { persisting: "error names" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 7,
        fault: "ambiguous",
        target: "Workflow:FLOW",
        op: "step_result",
      },
    ]);
    expect(instances(names)[0]?.output).toEqual({
      // Rethrown as it was thrown, as the engine does (it only logs the renamed error).
      byMessage: { name: "Error", message: "NonRetryableError: stop" },
      prefixed: 1,
      objectNamed: 2,
      timeout: { name: "WorkflowTimeoutError", message: "Execution timed out after 30000ms" },
    });
    // A step marked sensitive keeps the setting, and its output is redacted in the trace.
    const secret = await run(scenario("PersistingFlow", { body: { persisting: "sensitive" } }));
    expect(instances(secret)[0]?.output).toMatchObject({ sensitive: "output", token: "s3cr3t" });
    const recorded = of(secret, "step_result").map(
      (e) => (e.payload as { result: unknown }).result,
    );
    expect(recorded).toEqual([{ output: "[REDACTED]" }]);
    // A result over the engine's 1 MiB is not modelled.
    const big = await run(scenario("PersistingFlow", { body: { persisting: "too large" } }));
    expect(big.unsupportedReasons.join()).toContain("output is too large");
    // Byte buffers count toward the limit too.
    const buffer = await run(scenario("PersistingFlow", { body: { persisting: "big buffer" } }));
    expect(buffer.unsupportedReasons.join()).toContain("output is too large");
    // The delay function's context is the engine's, not what the callback did to its own.
    const mutatedContext = await run(
      scenario("PersistingFlow", { body: { persisting: "mutated context" } }),
    );
    expect(instances(mutatedContext)[0]?.output).toEqual({ seen: 1 });
    // A sibling step that fails after the invocation crashed persists nothing: after the restart it runs
    // again, whatever the order of the crash and its failure.
    // The sibling is still running its callback when the crash comes.
    for (const ticks of [50]) {
      siblingRuns = 0;
      siblingTicks = ticks;
      const sib = await run(
        scenario("PersistingFlow", { body: { persisting: "sibling throws after crash" } }),
        [
          {
            invocation: "workflow:FLOW:p1#1",
            ordinal: 2,
            fault: "crash_after",
            target: "Workflow:FLOW",
            op: "step_result",
          },
        ],
      );
      expect(instances(sib)[0]?.status, `ticks ${ticks}`).toBe("complete");
      expect(siblingRuns, `ticks ${ticks}`).toBe(2);
    }
    // A thrown plain value reaches run() as it was thrown.
    const plain = await run(scenario("PersistingFlow", { body: { persisting: "plain throw" } }));
    expect(instances(plain)[0]?.output).toEqual({ code: "DECLINED" });
    // A failure replayed after a restart keeps its type.
    const typed = await run(scenario("PersistingFlow", { body: { persisting: "typed" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(instances(typed)[0]?.output).toEqual({ typed: true });
    // The crashed run's delay function is never called again; its retries use the default delay.
    runsOfPersisting = 0;
    staleCalls = 0;
    const stale = await run(scenario("PersistingFlow", { body: { persisting: "stale delay" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(staleCalls).toBe(1);
    expect(instances(stale)[0]?.status).toBe("complete");
    // Restarted before its second attempt, the step keeps the limit its first attempt had.
    runsOfPersisting = 0;
    const configured = await run(scenario("PersistingFlow", { body: { persisting: "config" } }), [
      {
        invocation: "workflow:FLOW:p1#1",
        ordinal: 2,
        fault: "crash_before",
        target: "Workflow:FLOW",
        op: "step",
      },
    ]);
    expect(instances(configured)[0]).toMatchObject({ status: "complete", output: 2 });
  });

  test("a step's boundaries are turns: a concurrent caller can see the instance running between steps", async () => {
    const seen = new Set<string>();
    const handler: WorkerHandler = {
      async fetch(request, env) {
        const flow = (env as FlowEnv).FLOW as unknown as {
          create(o: unknown): Promise<unknown>;
          get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
        };
        const { role } = (await request.json()) as { role: string };
        if (role === "start") {
          await flow.create({ id: "pure" });
          return new Response("ok");
        }
        for (let i = 0; i < 3; i++) seen.add((await (await flow.get("pure")).status()).status);
        return new Response("ok");
      },
    };
    const spec = defineScenario({
      name: "workflow-pure-turns",
      worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
      drive: http(
        [
          { path: "/", body: { role: "start" } },
          { path: "/", body: { role: "watch" } },
        ],
        { retries: 0 },
      ),
      setup: [workflow("FLOW", "PureFlow")],
      invariants: [
        { kind: "unique", name: "one-instance", query: workflowRows("FLOW"), path: "id" },
      ],
      bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 3 },
    });
    const verdict = await explore(
      spec,
      createCloudflarePlatform({
        env: { FLOW: realBinding },
        handler,
        schemas: {},
        exports: { PureFlow },
      }),
      { seed: 0, exhaustive: true, leakCheckRuns: 0 },
    );
    expect(verdict.kind).toBe("BOUNDED");
    expect(seen.has("running")).toBe(true);
  });

  test("event.workflowName is the configured name, and reading it without one is UNSUPPORTED", async () => {
    const named = {
      ...scenario("NamedFlow"),
      setup: [workflow("FLOW", "NamedFlow", { name: "named-flow" })],
    };
    const r = await run(named);
    expect(instances(r)[0]?.output).toEqual({ name: "named-flow" });
    const r2 = await run(scenario("NamedFlow"));
    expect(r2.unsupportedReasons.join()).toContain("event.workflowName needs the Workflow's name");
  });

  test("what is not modelled makes the run UNSUPPORTED", async () => {
    const r = await run(scenario("WaitingFlow"));
    expect(r.unsupportedReasons.join()).toContain("waitForEvent is not modelled");
    const noSetup = { ...scenario("ReplyFlow"), setup: [] };
    const r2 = await run(noSetup);
    expect(r2.unsupportedReasons.join()).toContain("needs a workflow() setup step");
  });
});
