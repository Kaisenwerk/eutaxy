/**
 * Queue semantics of the Cloudflare platform, tested in Node without D1:
 * a scenario with no setup needs no bindings, so delivery, acknowledgement,
 * redelivery, dead-lettering and background work can be checked directly.
 */
import type { AtLeastOnce, EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { explore, Run, replayChooser, restrictSpec, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { atLeastOncePerMessage, http, queue } from "./scenario.ts";

const acked: AtLeastOnce = {
  kind: "atLeastOnce",
  name: "acked",
  effect: { target: "Queue:q", op: "ack", kind: "result" },
  key: "args.messageId",
  expected: ["msg-1"],
};

function spec(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    version: 1,
    name: "queue-semantics",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: queue("q", [{ body: { orderId: "o-1", n: 0 } }]),
    setup: [],
    externals: [],
    invariants: [acked],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 3,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
    ...overrides,
  };
}

type Handler = NonNullable<WorkerHandler["queue"]>;

function platformFor(handler: Handler, env: object = {}) {
  return createCloudflarePlatform({ env, handler: { queue: handler }, schemas: {} });
}

async function logOf(
  s: ScenarioSpec,
  handler: Handler,
  faults: Schedule["faults"] = [],
): Promise<EffectLog> {
  const run = new Run({
    chooser: replayChooser({ seed: 1, faults }),
    bounds: s.bounds,
  });
  return runOnce(s, platformFor(handler), run);
}

const ops = (log: EffectLog) => log.entries.map((e) => `${e.invocation} ${e.kind} ${e.op}`);

describe("acknowledgement", () => {
  test("a handler that returns without deciding gets an implicit ack", async () => {
    const log = await logOf(spec(), async () => {});
    expect(ops(log)).toEqual(["msg-1#1 call ack", "msg-1#1 result ack"]);
    expect(log.entries[0]?.payload).toEqual({
      args: { messageId: "msg-1", implicit: true, body: { orderId: "o-1", n: 0 } },
    });
  });

  test("the first decision wins: retry then ack still redelivers", async () => {
    const log = await logOf(spec(), async (batch) => {
      for (const m of batch.messages) {
        m.retry();
        m.ack();
      }
    });
    // Both calls are recorded; only the first took effect.
    const first = log.entries.filter((e) => e.invocation === "msg-1#1" && e.kind === "result");
    expect(first.map((e) => [e.op, e.payload])).toEqual([
      [
        "retry",
        {
          args: { messageId: "msg-1", body: { orderId: "o-1", n: 0 } },
          result: { effective: true },
        },
      ],
      [
        "ack",
        {
          args: { messageId: "msg-1", implicit: false, body: { orderId: "o-1", n: 0 } },
          result: { effective: false },
        },
      ],
    ]);
    const attempts = new Set(log.entries.map((e) => e.invocation));
    expect(attempts).toEqual(new Set(["msg-1#1", "msg-1#2", "msg-1#3", "msg-1#4", "platform"]));
    expect(ops(log).at(-1)).toBe("platform result dead_letter");
  });

  test("a throwing handler is redelivered up to max_retries and then dead-lettered", async () => {
    const log = await logOf(spec(), async () => {
      throw new Error("boom");
    });
    expect(log.entries.map((e) => `${e.kind} ${e.op}`)).toEqual([
      "call dead_letter",
      "result dead_letter",
    ]);
    expect(log.entries[1]?.payload).toEqual({
      args: { messageId: "msg-1", attempts: 4 },
      result: null,
    });
  });

  test("the scenario's maxRedeliveries bounds redelivery below max_retries", async () => {
    const log = await logOf(
      spec({ bounds: { ...spec().bounds, maxRedeliveries: 1 } }),
      async (batch) => {
        batch.retryAll();
      },
    );
    expect(ops(log).filter((o) => o.endsWith("retry")).length).toBe(4); // 2 attempts x (call, result)
    expect(ops(log).at(-1)).toBe("platform result dead_letter");
  });
});

describe("crashes", () => {
  test("a crash on the last permitted attempt dead-letters and still yields a verdict", async () => {
    const s = spec({ bounds: { ...spec().bounds, maxRedeliveries: 0 } });
    const verdict = await explore(
      s,
      platformFor(async (batch) => batch.ackAll()),
      {
        seed: 1,
        faultProbability: 1,
        now: () => 0,
      },
    );
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("acked");
    expect(ops(verdict.trace)).toContain("platform result dead_letter");
  });

  test("with redeliveries available, one crash per run is always recovered", async () => {
    const verdict = await explore(
      spec(),
      platformFor(async (batch) => batch.ackAll()),
      {
        seed: "recover",
        maxRuns: 30,
        faultProbability: 1,
        now: () => 0,
      },
    );
    expect(verdict.kind).toBe("BOUNDED");
  });
});

describe("restrictEvents", () => {
  test("keeps only the named messages and leaves the rest of the spec alone", () => {
    const s = spec({ drive: queue("q", [{ body: 1 }, { body: 2 }, { body: 3 }]) });
    const r = platformFor(async () => {}).restrictEvents(s, ["msg-3", "msg-1"]);
    expect((r.drive["messages"] as { id: string }[]).map((m) => m.id)).toEqual(["msg-1", "msg-3"]);
    expect(r.invariants).toBe(s.invariants);
  });
});

describe("isolation", () => {
  test("a handler that mutates its message body does not affect redeliveries or later runs", async () => {
    const seen: unknown[] = [];
    const handler: Handler = async (batch) => {
      const body = batch.messages[0]?.body as { n: number };
      seen.push(body.n);
      body.n += 1;
      throw new Error("retry me");
    };
    const s = spec({ bounds: { ...spec().bounds, maxRedeliveries: 1 } });
    await logOf(s, handler);
    await logOf(s, handler);
    expect(seen).toEqual([0, 0, 0, 0]);
    expect((s.drive["messages"] as { body: { n: number } }[])[0]?.body.n).toBe(0);
  });

  test("background work from waitUntil completes before delivery ends and never changes the ack", async () => {
    let finished = false;
    const log = await logOf(spec(), async (_batch, _env, ctx) => {
      ctx.waitUntil(
        Promise.resolve().then(() => {
          finished = true;
        }),
      );
      ctx.waitUntil(Promise.reject(new Error("background failure")));
    });
    expect(finished).toBe(true);
    expect(ops(log)).toEqual([
      "msg-1#1 call ack",
      "msg-1#1 result ack",
      "msg-1#1 call background",
      "msg-1#1 result background",
    ]);
    expect(log.entries[2]?.payload).toEqual({ args: { pending: 2 } });
  });

  test("touching a binding that is not proxied makes the run UNSUPPORTED", async () => {
    const env = { KV: { get: async () => null } };
    const verdict = await explore(
      spec(),
      platformFor(async (_batch, e) => {
        await (e as typeof env).KV.get();
      }, env),
      { seed: 1, now: () => 0 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("KV");
  });
});

describe("virtual clock and globals", () => {
  test("a handler that sleeps with setTimeout completes, and Date.now is virtual and repeatable", async () => {
    const seen: number[] = [];
    const handler: Handler = async (batch) => {
      seen.push(Date.now());
      await new Promise((r) => setTimeout(r, 30_000));
      seen.push(Date.now());
      batch.ackAll();
    };
    const log = await logOf(spec(), handler);
    expect(ops(log)).toEqual(["msg-1#1 call ack", "msg-1#1 result ack"]);
    expect(seen[1]).toBe((seen[0] as number) + 30_000);
    const again: number[] = [];
    await logOf(spec(), async (batch) => {
      again.push(Date.now(), Math.random());
      batch.ackAll();
    });
    const third: number[] = [];
    await logOf(spec(), async (batch) => {
      third.push(Date.now(), Math.random());
      batch.ackAll();
    });
    expect(again).toEqual(third);
    expect(again[0]).toBe(seen[0]);
  });

  test("a handler waiting on something Eutaxy cannot see makes the run UNSUPPORTED", async () => {
    const verdict = await explore(
      spec(),
      platformFor(async () => {
        await new Promise(() => {});
      }),
      { seed: 1, now: () => 0, maxRuns: 1 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("cannot see");
  });

  test("globals are restored after a run", async () => {
    const realNow = Date.now;
    await logOf(spec(), async (batch) => batch.ackAll());
    expect(Date.now).toBe(realNow);
  });
});

describe("inbound requests", () => {
  type Fetch = NonNullable<WorkerHandler["fetch"]>;
  const webhook = http([{ path: "/hooks/pay", body: { eventId: "evt-1" } }], { retries: 2 });
  const okResponses: AtLeastOnce = {
    kind: "atLeastOnce",
    name: "answered",
    effect: {
      target: "Http:/hooks/pay",
      op: "response",
      kind: "result",
      where: { "result.ok": true },
    },
    key: "args.requestId",
    expected: ["req-1"],
  };
  const httpSpec = (overrides: Partial<ScenarioSpec> = {}) =>
    spec({ drive: webhook, invariants: [okResponses], ...overrides });
  const platformFor = (fetch: Fetch, env: object = {}) =>
    createCloudflarePlatform({ env, handler: { fetch }, schemas: {} });
  async function logOf(
    s: ScenarioSpec,
    fetch: Fetch,
    faults: Schedule["faults"] = [],
  ): Promise<EffectLog> {
    const run = new Run({
      chooser: replayChooser({ seed: 1, faults }),
      bounds: s.bounds,
    });
    return runOnce(s, platformFor(fetch), run);
  }

  test("the request carries the drive's method, path, headers and JSON body", async () => {
    let seen = "";
    const log = await logOf(httpSpec(), async (request) => {
      const url = new URL(request.url);
      const body = (await request.json()) as { eventId: string };
      seen = `${request.method} ${url.pathname} ${request.headers.get("content-type")} ${body.eventId}`;
      return Response.json({ recorded: true }, { status: 201 });
    });
    expect(seen).toBe("POST /hooks/pay application/json evt-1");
    expect(ops(log)).toEqual(["req-1#1 call response", "req-1#1 result response"]);
    expect(log.entries[1]?.payload).toEqual({
      args: { requestId: "req-1", method: "POST", path: "/hooks/pay" },
      result: { status: 201, ok: true, body: { recorded: true } },
    });
  });

  test("a thrown error is a 500 the caller resends; a 2xx ends the resends", async () => {
    let calls = 0;
    const log = await logOf(httpSpec(), async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return new Response("done", { status: 200 });
    });
    expect(ops(log)).toEqual([
      "req-1#1 call response",
      "req-1#1 result response",
      "req-1#2 call response",
      "req-1#2 result response",
    ]);
    expect(log.entries[1]?.payload).toMatchObject({ result: { status: 500, ok: false } });
    expect(log.entries[3]?.payload).toMatchObject({ result: { status: 200, ok: true } });
  });

  test("with retryOn non-2xx a 4xx is resent until retries run out, then the caller gives up", async () => {
    const drive = http([{ path: "/hooks/pay", body: { eventId: "evt-1" } }], {
      retries: 1,
      retryOn: "non-2xx",
    });
    const log = await logOf(httpSpec({ drive }), async () => new Response("nope", { status: 409 }));
    expect(ops(log)).toEqual([
      "req-1#1 call response",
      "req-1#1 result response",
      "req-1#2 call response",
      "req-1#2 result response",
      "platform call gave_up",
      "platform result gave_up",
    ]);
  });

  test("with retryOn 5xx a 4xx is final", async () => {
    const drive = http([{ path: "/hooks/pay", body: { eventId: "evt-1" } }], { retryOn: "5xx" });
    const log = await logOf(httpSpec({ drive }), async () => new Response("", { status: 404 }));
    expect(ops(log)).toEqual(["req-1#1 call response", "req-1#1 result response"]);
  });

  test("a crash before the response is a request the caller never got answered, so it resends", async () => {
    const log = await logOf(httpSpec(), async () => new Response("ok"), [
      {
        invocation: "req-1#1",
        ordinal: 0,
        fault: "crash_before",
        target: "Http:/hooks/pay",
        op: "response",
      },
    ]);
    expect(ops(log)).toEqual([
      "req-1#1 call response",
      "req-1#1 fault response",
      "req-1#2 call response",
      "req-1#2 result response",
    ]);
  });

  test("a GET without a body, and waitUntil work after the response with the cut_off point", async () => {
    const drive = http([{ path: "/ping", method: "GET", id: "g" }], { retries: 0 });
    let bodyWasNull = false;
    let backgroundRan = false;
    const log = await logOf(httpSpec({ drive }), async (request, _env, ctx) => {
      bodyWasNull = request.body === null;
      ctx.waitUntil(
        Promise.resolve().then(() => {
          backgroundRan = true;
        }),
      );
      return new Response("pong");
    });
    expect(bodyWasNull).toBe(true);
    expect(backgroundRan).toBe(true);
    expect(ops(log)).toEqual([
      "g#1 call response",
      "g#1 result response",
      "g#1 call background",
      "g#1 result background",
    ]);
  });

  test("an explicit JSON null body is sent as null, not as no body", async () => {
    const drive = http([{ path: "/null", body: null }]);
    let seen: unknown = "unset";
    await logOf(httpSpec({ drive }), async (request) => {
      seen = `${request.method} ${request.headers.get("content-type")} ${JSON.stringify(await request.json())}`;
      return new Response("ok");
    });
    expect(seen).toBe("POST application/json null");
  });

  test("a response whose stream fails is a failed delivery the caller resends", async () => {
    const drive = http([{ path: "/stream", body: {} }], { retries: 1 });
    let calls = 0;
    const log = await logOf(httpSpec({ drive }), async () => {
      calls++;
      if (calls === 1) {
        const broken = new ReadableStream({
          pull(controller) {
            controller.error(new Error("stream broke"));
          },
        });
        return new Response(broken, { status: 200 });
      }
      return new Response("ok");
    });
    expect(ops(log)).toEqual([
      "req-1#1 call response",
      "req-1#1 result response",
      "req-1#2 call response",
      "req-1#2 result response",
    ]);
    expect(log.entries[1]?.payload).toMatchObject({ result: { status: 500, ok: false } });
  });

  test("a crash inside a streaming body abandons the read instead of hanging the delivery", async () => {
    const drive = http([{ path: "/stream", body: {} }], { retries: 1 });
    const log = await logOf(httpSpec({
      drive,
      externals: [{ name: "ext", host: "ext.test", guarantees: {} }],
    }), async () => {
      const stream = new ReadableStream({
        async pull(controller) {
          // Handler code running while the body is read: an effect point the engine can crash.
          await fetch("https://ext.test/chunk");
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }, [
      { invocation: "req-1#1", ordinal: 0, fault: "crash_before", target: "Fetch:ext", op: "GET" },
    ]);
    expect(ops(log)).toEqual([
      "req-1#1 call GET",
      "req-1#1 fault GET",
      "req-1#2 call GET",
      "req-1#2 result GET",
      "req-1#2 call response",
      "req-1#2 result response",
    ]);
  });

  test("a per-request invariant over a whole string body survives restriction", () => {
    const drive = http([
      { path: "/a", body: "evt-1" },
      { path: "/a", body: "evt-2" },
    ]);
    const inv = atLeastOncePerMessage("all", drive, { target: "Http:/a" }, "args.requestId", "");
    expect(inv.expected).toEqual(["evt-1", "evt-2"]);
    const platform = platformFor(async () => new Response());
    const restricted = restrictSpec(platform, httpSpec({ drive, invariants: [inv] }), ["req-2"]);
    expect((restricted.invariants[0] as AtLeastOnce).expected).toEqual(["evt-2"]);
  });

  test("restrictEvents keeps only the named requests", () => {
    const two = http([
      { path: "/a", body: 1 },
      { path: "/b", body: 2 },
    ]);
    const restricted = platformFor(async () => new Response()).restrictEvents(
      httpSpec({ drive: two }),
      ["req-2"],
    );
    expect((restricted.drive as typeof two).requests.map((r) => r.id)).toEqual(["req-2"]);
  });

  test("explore finds the lost response that makes a non-idempotent handler record twice", async () => {
    const writes: string[] = [];
    const verdict = await explore(
      httpSpec({
        invariants: [
          {
            kind: "atMostOncePerKey",
            name: "once",
            effect: { target: "Fetch:audit", op: "POST", kind: "result" },
            key: "args.body.eventId",
          },
        ],
        externals: [{ name: "audit", host: "audit.test", guarantees: {} }],
      }),
      platformFor(async (request) => {
        const body = (await request.json()) as { eventId: string };
        writes.push(body.eventId);
        await fetch("https://audit.test/log", { method: "POST", body: JSON.stringify(body) });
        return new Response("ok");
      }),
      { seed: 3, maxRuns: 30 },
    );
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind === "VIOLATED") expect(verdict.violation.invariant).toBe("once");
  });
});

describe("concurrent queue consumers", () => {
  test("each consumer's effects stay its own, through retries and dead-lettering", async () => {
    // m1 always asks for a retry until it is dead-lettered; m2 and m3 call out, then ack.
    const handler: Handler = async (batch) => {
      for (const message of batch.messages) {
        const id = (message.body as { id: string }).id;
        await fetch(`https://api.test/${id}/before`);
        if (id === "m1") {
          message.retry();
          continue;
        }
        await fetch(`https://api.test/${id}/after`);
        message.ack();
      }
    };
    const s = spec({
      drive: queue("q", [{ body: { id: "m1" } }, { body: { id: "m2" } }, { body: { id: "m3" } }]),
      externals: [{ name: "api", host: "api.test", guarantees: {} }],
      bounds: {
        maxFaultsPerRun: 0,
        maxRedeliveries: 1,
        maxConcurrentInvocations: 2,
        budgetMs: 10_000,
      },
    });
    for (const seed of [1, 2, 3, 4]) {
      const run = new Run({
        chooser: replayChooser({ seed, faults: [] }),
        bounds: s.bounds,
      });
      const log = await runOnce(s, platformFor(handler), run);
      expect(run.unsupportedReasons).toEqual([]);
      const fetches = log.entries.filter((e) => e.kind === "call" && e.target === "Fetch:api");
      expect(fetches.length).toBe(2 + 2 + 2);
      for (const f of fetches) {
        const url = String((f.payload as { args: { url: string } }).args.url);
        const n = /api\.test\/m(\d)\//.exec(url)?.[1];
        expect(f.invocation.startsWith(`msg-${n}#`), `${f.invocation} made ${url}`).toBe(true);
      }
      expect(ops(log)).toContain("platform result dead_letter");
    }
  });
});

describe("caller timing on the http drive", () => {
  type Fetch = NonNullable<WorkerHandler["fetch"]>;
  const answered: AtLeastOnce = {
    kind: "atLeastOnce",
    name: "answered",
    effect: { target: "Http:/hooks/chat", op: "response", kind: "result" },
    key: "args.requestId",
    expected: ["req-1"],
  };
  const timedSpec = (drive: ReturnType<typeof http>, maxConcurrentInvocations = 1) =>
    spec({
      drive,
      invariants: [answered],
      externals: [{ name: "api", host: "api.test", guarantees: {} }],
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 4,
        maxConcurrentInvocations,
        budgetMs: 10_000,
      },
    });
  async function runOf(
    s: ScenarioSpec,
    fetch: Fetch,
    faults: Schedule["faults"] = [],
    seed = 1,
  ): Promise<{ log: EffectLog; run: Run }> {
    const run = new Run({
      chooser: replayChooser({ seed, faults }),
      bounds: s.bounds,
    });
    const log = await runOnce(
      s,
      createCloudflarePlatform({ env: {}, handler: { fetch }, schemas: {} }),
      run,
    );
    return { log, run };
  }
  /** The virtual time each attempt's response reported, in log order. */
  const answerTimes = (log: EffectLog) =>
    log.entries
      .filter((e) => e.kind === "result" && e.op === "response")
      .map((e) => (e.payload as { result: { body: { at: number } } }).result.body.at);

  test("each resend waits its delaysMs entry of virtual time, and the last entry repeats", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], {
      retries: 3,
      delaysMs: [15_000, 300_000],
    });
    const { log } = await runOf(timedSpec(drive), async () =>
      Response.json({ at: Date.now() }, { status: 503 }),
    );
    const [first, second, third, fourth] = answerTimes(log) as [number, number, number, number];
    expect(second - first).toBe(15_000);
    expect(third - second).toBe(300_000);
    expect(fourth - third).toBe(300_000);
  });

  test("without delaysMs resends come at once, as before", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 1 });
    const { log } = await runOf(timedSpec(drive), async () =>
      Response.json({ at: Date.now() }, { status: 503 }),
    );
    const [first, second] = answerTimes(log) as [number, number];
    expect(second - first).toBeLessThan(10);
  });

  test("an answer later than deadlineMs in virtual time is resent, then the caller gives up", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 1, deadlineMs: 3_000 });
    const { log } = await runOf(timedSpec(drive), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return Response.json({ at: Date.now() });
    });
    expect(ops(log)).toEqual([
      "req-1#1 call response",
      "req-1#1 result response",
      // The caller gives up at its deadline, before the late answer arrives.
      "platform call gave_up",
      "platform result gave_up",
      "req-1#2 call response",
      "req-1#2 result response",
    ]);
  });

  test("a late answer (ambiguous at the response) is resent while the first attempt's background work runs", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 1, deadlineMs: 3_000 });
    const handler: Fetch = async (_request, _env, ctx) => {
      // The background work takes 5 s of virtual time between its two calls, longer than the
      // caller's 3 s deadline, so the resend arrives while it runs.
      ctx.waitUntil(
        (async () => {
          await fetch("https://api.test/one");
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          await fetch("https://api.test/two");
        })(),
      );
      return Response.json({ at: Date.now() });
    };
    const late = [
      {
        invocation: "req-1#1",
        ordinal: 0,
        fault: "ambiguous" as const,
        target: "Http:/hooks/chat",
        op: "response",
      },
    ];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { log, run } = await runOf(timedSpec(drive, 2), handler, late, seed);
      expect(run.unsupportedReasons).toEqual([]);
      const order = ops(log);
      expect(order).toContain("req-1#1 fault response");
      expect(order).toContain("req-1#2 result response");
      // Both attempts' background work ran to the end.
      expect(order.filter((o) => o.endsWith("call GET"))).toHaveLength(4);
      // The resend's answer comes before the first attempt's second background call.
      expect(order.indexOf("req-1#2 call response")).toBeLessThan(
        order.lastIndexOf("req-1#1 call GET"),
      );
    }
  });

  test("the caller gives up at its deadline while the handler still runs, and resends then", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 1, deadlineMs: 3_000 });
    // The handler takes 5 s of virtual time; with two slots the resend starts at the 3 s deadline.
    const { log, run } = await runOf(timedSpec(drive, 2), async () => {
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return Response.json({ at: started });
    });
    expect(run.unsupportedReasons).toEqual([]);
    const [first, second] = answerTimes(log) as [number, number];
    expect(second - first).toBe(3_000);
  });

  test("the caller giving up mid-handler does not take over the handler's later effects", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 0, deadlineMs: 100 });
    const { log } = await runOf(timedSpec(drive), async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fetch("https://api.test/after-deadline");
      return Response.json({ at: Date.now() });
    });
    expect(ops(log)).toEqual([
      "platform call gave_up",
      "platform result gave_up",
      "req-1#1 call GET",
      "req-1#1 result GET",
      "req-1#1 call response",
      "req-1#1 result response",
    ]);
  });

  test("without deadlineMs an answer is never late", async () => {
    const drive = http([{ path: "/hooks/chat", body: {} }], { retries: 1 });
    const { log } = await runOf(timedSpec(drive), async () => Response.json({ at: Date.now() }), [
      {
        invocation: "req-1#1",
        ordinal: 0,
        fault: "ambiguous",
        target: "Http:/hooks/chat",
        op: "response",
      },
    ]);
    expect(ops(log)).toEqual(["req-1#1 call response", "req-1#1 result response"]);
  });
});
