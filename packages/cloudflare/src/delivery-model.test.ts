/**
 * The Cloudflare platform held to the delivery model core proves
 * (`deliveries`): a queue message, an inbound request, a cron tick and an
 * RPC call are each delivered exactly as often as the model says, attempt
 * by attempt, to a handler called once per delivery, on every list of
 * outcomes, every limit of the platform's (the consumer's max_retries, the
 * declared caller's retries) and every bound of the scenario's up to a
 * bound. A delivery is made not handled in these ways: the handler says
 * so (a retry, a 500), throws, answers after its caller's deadline, fails
 * in its background work, or an injected crash ends it in a call of its
 * own or loses its acknowledgement or its response; a tick that fails
 * after `noRetry()` counts as handled, since it is not to be delivered
 * again.
 * Two queue messages and two requests are also in flight together, under
 * every order of turns. Exhaustive within the bounds, not sampled. An
 * alarm's deliveries are held to the model in workerd
 * (`workerd/alarm-deliveries`).
 */
import {
  type Bounds,
  deliveries,
  type FaultDecision,
  invocationOf,
  type Platform,
  type ScenarioSpec,
} from "@eutaxy/core";
import { explore, Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform } from "./platform.ts";
import { cron, type HttpCallerOptions, http, queue, rpc } from "./scenario.ts";

/** Whether the delivery now running, of the event with this id, is handled. */
type Script = (id: string) => boolean;

/** One way events reach the Worker and are handled or not, under a limit of the platform's. */
interface Delivered {
  readonly name: string;
  /** The ids of the drive's events. */
  readonly ids: readonly string[];
  /** The drive, the limit in it when it is the caller's. */
  drive(limit: number): ScenarioSpec["drive"];
  /** The platform whose handler does what the script says, the limit in it when it is the consumer's. */
  platform(limit: number, script: Script): Platform;
  /** Where a delivery is not handled because a crash is injected: the crash of the event's attempt. */
  readonly crash?: (id: string, attempt: number) => FaultDecision;
}

/** What a handler calls before it decides or answers: an effect, so two in flight have turns to order. */
const store = "https://store.test/";

/** Queue messages, as many as asked for, to a consumer that decides each as `decide` says. */
function messages(
  name: string,
  count: number,
  decide: (message: Message, handled: boolean) => void,
  crash?: Delivered["crash"],
): Delivered {
  return {
    name,
    ids: Array.from({ length: count }, (_, i) => `msg-${i + 1}`),
    drive: () =>
      queue(
        "q",
        Array.from({ length: count }, () => ({ body: null })),
      ),
    platform: (limit, script) =>
      createCloudflarePlatform({
        env: {},
        schemas: {},
        maxRetries: limit,
        handler: {
          queue: async (batch) => {
            // Asked first, so a handler a crash ends at its call still counts as called.
            const handled = batch.messages.map((m) => script(m.id));
            await fetch(store);
            batch.messages.forEach((m, i) => {
              decide(m, handled[i] ?? false);
            });
          },
        },
      }),
    ...(crash === undefined ? {} : { crash }),
  };
}

/** A crash at the handler's call to the store, its first effect: the handler never decides or answers. */
const inTheHandler: Delivered["crash"] = (id, attempt) => ({
  invocation: `${id}#${attempt}`,
  ordinal: 0,
  fault: "crash_before",
  target: "Fetch:store",
  op: "GET",
});

const decided = (count: number) =>
  messages("a queue message the handler acknowledges or retries", count, (m, handled) =>
    handled ? m.ack() : m.retry(),
  );

const returned = (count: number) =>
  messages("a queue message a return acknowledges and a throw leaves", count, (_m, handled) => {
    if (!handled) throw new Error("not handled");
  });

/** Inbound requests, as many as asked for, whose caller resends up to the limit, answered as `answer` says. */
function requests(
  name: string,
  count: number,
  answer: (handled: boolean) => Response | Promise<Response>,
  caller: HttpCallerOptions = {},
  crash?: Delivered["crash"],
): Delivered {
  const ids = Array.from({ length: count }, (_, i) => `req-${i + 1}`);
  return {
    name,
    ids,
    drive: (limit) =>
      http(
        ids.map((id) => ({ path: `/${id}` })),
        { ...caller, retries: limit },
      ),
    platform: (_limit, script) =>
      createCloudflarePlatform({
        env: {},
        schemas: {},
        handler: {
          fetch: async (request) => {
            const handled = script(new URL(request.url).pathname.slice(1));
            await fetch(store);
            return answer(handled);
          },
        },
      }),
    ...(crash === undefined ? {} : { crash }),
  };
}

const answered = (count: number) =>
  requests("an inbound request answered 200 or 500", count, (handled) =>
    handled ? new Response("ok") : new Response("failed", { status: 500 }),
  );

/** A cron tick the handler deals with as `run` says; the caller's limit is the drive's `retries`. */
function tick(
  name: string,
  run: (handled: boolean, controller: ScheduledController, ctx: ExecutionContext) => void,
): Delivered {
  return {
    name,
    ids: ["tick-1"],
    drive: (limit) => cron("* * * * *", { retries: limit }),
    platform: (_limit, script) =>
      createCloudflarePlatform({
        env: {},
        schemas: {},
        handler: {
          scheduled: async (controller, _env, ctx) => run(script("tick-1"), controller, ctx),
        },
      }),
  };
}

/** The runtime's base class, as far as construction goes: it is found by name. */
class WorkerEntrypoint {
  readonly env: unknown;
  constructor(_ctx: unknown, env: unknown) {
    this.env = env;
  }
}

/** The script of the scenario whose platform was made last: a class has no other way to it. */
let serviceScript: Script = () => false;

/** An RPC service whose one method is handled when it returns. */
class Service extends WorkerEntrypoint {
  call(): string {
    if (!serviceScript("call-1")) throw new Error("not handled");
    return "ok";
  }
}

const ways: Delivered[] = [
  decided(1),
  returned(1),
  messages(
    "a queue message whose implicit acknowledgement a crash loses",
    1,
    () => {},
    // The handler's call to the store is the invocation's first effect; the implicit ack its second.
    (id, attempt) => ({
      invocation: `${id}#${attempt}`,
      ordinal: 1,
      fault: "crash_before",
      target: "Queue:q",
      op: "ack",
    }),
  ),
  messages("a queue message whose handler a crash ends", 1, () => {}, inTheHandler),
  answered(1),
  requests(
    "an inbound request whose handler a crash ends",
    1,
    () => new Response("ok"),
    {},
    inTheHandler,
  ),
  requests("an inbound request answered or failed with an exception", 1, (handled) => {
    if (!handled) throw new Error("not handled");
    return new Response("ok");
  }),
  requests(
    "an inbound request answered in time or after its caller's deadline, resent after a delay",
    1,
    async (handled) => {
      // Virtual time: the caller gives up at its deadline while this attempt still runs.
      if (!handled) await new Promise((resolve) => setTimeout(resolve, 2_000));
      return new Response(handled ? "ok" : "late");
    },
    { deadlineMs: 1_000, delaysMs: [500] },
  ),
  requests(
    "an inbound request whose response a crash loses",
    1,
    () => new Response("ok"),
    {},
    // The response is the invocation's second effect, as the implicit ack is.
    (id, attempt) => ({
      invocation: `${id}#${attempt}`,
      ordinal: 1,
      fault: "crash_before",
      target: `Http:/${id}`,
      op: "response",
    }),
  ),
  tick("a cron tick that returns or throws", (handled) => {
    if (!handled) throw new Error("not handled");
  }),
  tick("a cron tick whose background work succeeds or fails", (handled, _controller, ctx) => {
    ctx.waitUntil(handled ? Promise.resolve() : Promise.reject(new Error("not handled")));
  }),
  tick("a cron tick that fails, after noRetry() when it is not to run again", (handled, c) => {
    if (handled) c.noRetry();
    throw new Error("failed");
  }),
  {
    name: "an RPC call",
    ids: ["call-1"],
    drive: (limit) => rpc([{ method: "call" }], { retries: limit }),
    platform: (_limit, script) => {
      serviceScript = script;
      return createCloudflarePlatform({ env: {}, schemas: {}, handler: Service });
    },
  },
];

/** Every list of `length` outcomes. */
function outcomes(length: number): boolean[][] {
  return Array.from({ length: 2 ** length }, (_, bits) =>
    Array.from({ length }, (_, i) => ((bits >> i) & 1) === 1),
  );
}

/**
 * The scenario of these events, each with its list of outcomes, and its
 * platform, which counts: `wrong` gets a line for every run in which an
 * event was not delivered as its attempts in order, as many as the model
 * says, to a handler called once per delivery; `runs` counts the runs.
 * `faults` are the crashes that make the deliveries the lists say are not
 * handled so, where that is the way's.
 */
function scripted(
  way: Delivered,
  lists: readonly (readonly boolean[])[],
  limit: number,
  bounds: Bounds,
): {
  spec: ScenarioSpec;
  platform: Platform;
  faults: FaultDecision[];
  wrong: string[];
  runs: () => number;
} {
  const { ids, crash } = way;
  const delivered: string[] = [];
  const asked = new Map<string, number>();
  const wrong: string[] = [];
  let runs = 0;
  const script: Script = (id) => {
    const at = asked.get(id) ?? 0;
    asked.set(id, at + 1);
    // Past the list's end the model says no delivery is made; one made anyway is counted and fails.
    return lists[ids.indexOf(id)]?.[at] ?? false;
  };
  const inner = way.platform(limit, script);
  const platform: Platform = {
    ...inner,
    async reset(spec) {
      delivered.length = 0;
      asked.clear();
      await inner.reset(spec);
    },
    deliver(event, hooks, spec) {
      delivered.push(invocationOf(event));
      return inner.deliver(event, hooks, spec);
    },
    async cleanup(spec) {
      runs++;
      ids.forEach((id, i) => {
        const count = deliveries(lists[i] ?? [], limit, bounds.maxRedeliveries);
        const expected = Array.from({ length: count }, (_, n) => `${id}#${n + 1}`);
        const made = delivered.filter((d) => d.startsWith(`${id}#`));
        if (made.join() !== expected.join() || asked.get(id) !== count)
          wrong.push(
            `${id} with outcomes ${JSON.stringify(lists[i])}, limit ${limit}, bound ${bounds.maxRedeliveries}: delivered ${JSON.stringify(made)} to a handler called ${asked.get(id) ?? 0} times, the model says ${count}`,
          );
      });
      await inner.cleanup?.(spec);
    },
  };
  const spec: ScenarioSpec = {
    version: 1,
    name: "delivery-model",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: way.drive(limit),
    setup: [],
    externals: [{ name: "store", host: "store.test", guarantees: {} }],
    invariants: [],
    bounds,
  };
  const faults =
    crash === undefined
      ? []
      : ids.flatMap((id, i) =>
          (lists[i] ?? []).flatMap((handled, n) => (handled ? [] : [crash(id, n + 1)])),
        );
  return { spec, platform, faults, wrong, runs: () => runs };
}

describe("the Cloudflare platform refines the proved delivery model", () => {
  // Six outcomes under limits up to four: every limit is passed by a list that goes on beyond it.
  const lists = outcomes(6);
  const limits = [0, 1, 2, 3, 4];

  test.each(ways)(
    "$name: every list of six outcomes under every limit and bound up to four",
    async (way) => {
      for (const handled of lists)
        for (const limit of limits)
          for (const maxRedeliveries of limits) {
            const bounds = {
              maxFaultsPerRun: 0,
              maxRedeliveries,
              maxConcurrentInvocations: 1,
              budgetMs: 10_000,
            };
            const s = scripted(way, [handled], limit, bounds);
            // A replayed schedule takes the faults it lists, however many: the bound is the chooser's.
            const run = new Run({ bounds, chooser: replayChooser({ seed: 1, faults: s.faults }) });
            await runOnce(s.spec, s.platform, run);
            expect(run.unsupportedReasons).toEqual([]);
            expect(s.runs()).toBe(1);
            expect(s.wrong).toEqual([]);
          }
    },
  );

  test.each([decided(2), answered(2)])(
    "$name, two in flight: every pair of lists of four outcomes under every limit and bound up to two, under every order of turns",
    async (way) => {
      const few = outcomes(4);
      const low = [0, 1, 2];
      let scenarios = 0;
      let schedules = 0;
      for (const first of few)
        for (const second of few)
          for (const limit of low)
            for (const maxRedeliveries of low) {
              const bounds = {
                maxFaultsPerRun: 0,
                maxRedeliveries,
                maxConcurrentInvocations: 2,
                budgetMs: 10_000,
              };
              const s = scripted(way, [first, second], limit, bounds);
              const verdict = await explore(s.spec, s.platform, {
                seed: "delivery-model",
                exhaustive: { reduction: false },
                maxRuns: 10_000,
                now: () => 0,
              });
              expect(verdict.kind).toBe("BOUNDED");
              if (verdict.kind !== "BOUNDED") return;
              expect(verdict.reached.exhaustive?.complete).toBe(true);
              expect(s.runs()).toBeGreaterThanOrEqual(verdict.reached.exhaustive?.schedules ?? 0);
              expect(s.wrong).toEqual([]);
              scenarios++;
              schedules += verdict.reached.exhaustive?.schedules ?? 0;
            }
      // The two events' turns interleave: more schedules than scenarios.
      expect(schedules).toBeGreaterThan(scenarios);
    },
  );
});
