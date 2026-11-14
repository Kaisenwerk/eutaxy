/**
 * Test support for the nested-call tests (`nested-calls*.test.ts`): a fake
 * runtime of objects and Workers over a real `Run`, the timings an
 * innermost call can have, the nestings it can be reached through, and the
 * checks the tests share. The tests are split over several files only so
 * that they run side by side. Not part of the engine.
 */
import type { Bounds, EffectRecord, FaultKind, Platform, ScenarioSpec } from "@eutaxy/core";
import { expect } from "vitest";
import { replayChooser } from "./chooser.ts";
import { hostInvocation, runInvocation } from "./deliver.ts";
import { runOnce } from "./explore.ts";
import { Run } from "./run.ts";

const budgetMs = 2_000;
const bounds = (concurrent: number): Bounds => ({
  maxFaultsPerRun: 1,
  maxRedeliveries: 0,
  maxConcurrentInvocations: concurrent,
  budgetMs,
});
const spec = (concurrent: number): ScenarioSpec => ({
  version: 1,
  name: "nested",
  worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: [] },
  setup: [],
  externals: [],
  invariants: [],
  bounds: bounds(concurrent),
});
const none = () => null;
export const kinds: FaultKind[] = ["crash_before", "crash_after", "error", "ambiguous"];

interface Resource {
  runInAsyncScope<T>(code: () => T): T;
}
interface Storage<T> {
  run<R>(store: T, code: () => R): R;
  getStore(): T | undefined;
}
// Reached as the engine reaches async context: it has no Node types of its own.
const asyncHooks = process?.getBuiltinModule?.("node:async_hooks") as
  | {
      AsyncResource: new (name: string) => Resource;
      AsyncLocalStorage: new <T>() => Storage<T>;
    }
  | undefined;
if (!asyncHooks) throw new Error("these tests need node:async_hooks");
/** Created outside every run: code run in it has no async context of a caller's, as an object's code has none in the runtime. */
const runtime = new asyncHooks.AsyncResource("runtime");

/**
 * The instance of an object whose code is running, as the runtime knows
 * it: a reset tears the instance's context down, so nothing that was
 * awaiting in it resumes, a Worker it called included (that Worker's code
 * runs in the object's context), and every call in flight into it fails.
 * The fake runtime of these tests does the same, where plain promises
 * would let a reset object's code run on.
 */
interface Instance {
  readonly name: string;
  readonly born: number;
  /** Per object of the run, how many times it was reset. */
  readonly resetCounts: Map<string, number>;
}
const instances = new asyncHooks.AsyncLocalStorage<Instance>();
const torn = (): boolean => {
  const me = instances.getStore();
  return me !== undefined && (me.resetCounts.get(me.name) ?? 0) !== me.born;
};
const never = new Promise<never>(() => {});
/** What an object's code awaits: it resumes only in an instance that is still the object's. */
async function alive<T>(work: () => Promise<T>): Promise<T> {
  if (torn()) return never;
  try {
    const value = await work();
    return torn() ? never : value;
  } catch (err) {
    if (torn()) return never;
    throw err;
  }
}
/**
 * An effect's real work, as the code that made the effect sees it end: in
 * the runtime that is awaited in the context of the code that made it, so
 * once that context was torn down its end is never seen there.
 */
const settledWhereAlive = alive;
export const sleep = (ms: number) => alive(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** What a handler or an object's method has to work with. */
export interface Kit {
  readonly run: Run;
  /** The objects reset so far, in order. */
  readonly resets: string[];
  /** Call the object `name`, from whatever code is running. */
  call<T>(
    name: string,
    method: () => T | Promise<T>,
    options?: { allowed?: FaultKind[]; gated?: boolean; entering?: () => Promise<void> },
  ): Promise<T>;
  /** Call another Worker, whose handler runs as the invocation `id` hosted inside the call. */
  worker<T>(
    id: string,
    handler: () => T | Promise<T>,
    options?: { allowed?: FaultKind[] },
  ): Promise<T>;
  /** An effect of the running code's own. */
  fetch(op: string, allowed?: FaultKind[]): Promise<number>;
}

interface Fault {
  readonly invocation: string;
  readonly ordinal: number;
  readonly fault: FaultKind;
  readonly target: string;
  readonly op: string;
}

export interface Ran {
  readonly run: Run;
  readonly entries: readonly EffectRecord[];
  readonly lines: string[];
  readonly status: Record<string, string>;
  readonly value: Record<string, unknown>;
  readonly resets: string[];
  readonly ms: number;
}

const line = (e: EffectRecord) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`;

/** One run: each event's handler is `handler`, run as the Worker's code. */
export async function once(
  concurrent: number,
  handler: (kit: Kit, event: string) => Promise<unknown>,
  options: {
    faults?: readonly Fault[];
    events?: { id: string; at?: number }[];
    seed?: number;
  } = {},
): Promise<Ran> {
  const resets: string[] = [];
  const resetCounts = new Map<string, number>();
  /** Per object, how to fail each call in flight into it. */
  const inFlightInto = new Map<string, Set<(reason: Error) => void>>();
  const status: Record<string, string> = {};
  const value: Record<string, unknown> = {};
  const run = new Run({
    chooser: replayChooser({ seed: options.seed ?? 1, faults: options.faults ?? [] }),
    bounds: bounds(concurrent),
  });
  const kit: Kit = {
    run,
    resets,
    call: (name, method, o = {}) => {
      const host = `DO:X/${name}`;
      return alive(() =>
        run.effect(
          {
            invocation: run.running(),
            target: "DO:X",
            op: name,
            args: null,
            allowed: o.allowed ?? [],
            hostsEffects: true,
          },
          () =>
            settledWhereAlive(async () => {
              // A reset of the object fails every call in flight into it.
              let drop: (reason: Error) => void = () => {};
              const dropped = new Promise<never>((_, reject) => {
                drop = reject;
              });
              const calls = inFlightInto.get(name) ?? new Set();
              inFlightInto.set(name, calls);
              calls.add(drop);
              const born = resetCounts.get(name) ?? 0;
              try {
                return await Promise.race([
                  // The runtime enters the object with no context of the caller's.
                  runtime.runInAsyncScope(() =>
                    instances.run({ name, born, resetCounts }, async () => {
                      if (o.entering) await run.hostEntering(host, o.entering);
                      return run.hostedCode(host, method, name);
                    }),
                  ),
                  dropped,
                ]);
              } finally {
                calls.delete(drop);
              }
            }),
          none,
          {
            host,
            onAbandon: () => {
              resets.push(name);
              resetCounts.set(name, (resetCounts.get(name) ?? 0) + 1);
              for (const fail of [...(inFlightInto.get(name) ?? [])])
                fail(new Error(`the object ${name} was reset`));
            },
            ...(o.gated ? { mayPark: () => false } : {}),
          },
        ),
      );
    },
    worker: (id, handler, o = {}) =>
      alive(() =>
        run.effect(
          {
            invocation: run.running(),
            target: "Service:SVC",
            op: "handle",
            args: null,
            allowed: o.allowed ?? [],
          },
          () =>
            settledWhereAlive(async () => {
              const outcome = await hostInvocation(run, id, (inv) =>
                runInvocation(run, inv, handler),
              );
              status[id] = outcome.status;
              if (outcome.status === "completed") return outcome.value;
              throw outcome.status === "errored" ? outcome.error : new Error("the callee crashed");
            }),
          none,
        ),
      ),
    fetch: (op, allowed = kinds) =>
      alive(() =>
        run.effect(
          { invocation: run.running(), target: "Fetch:api", op, args: null, allowed },
          () => settledWhereAlive(async () => 1),
          none,
        ),
      ),
  };
  const platform: Platform = {
    name: "objects",
    assumptions: [],
    concurrent: true,
    reset: async () => {},
    initialEvents: () =>
      (options.events ?? [{ id: "e" }]).map((e) => ({
        id: e.id,
        attempt: 1,
        data: null,
        ...(e.at ? { at: e.at } : {}),
      })),
    restrictEvents: (s) => s,
    async deliver(event, hooks) {
      const inv = hooks.startInvocation(`${event.id}#${event.attempt}`);
      const outcome = await runInvocation(hooks, inv, () => handler(kit, event.id));
      status[inv.id] = outcome.status;
      if (outcome.status === "completed") value[inv.id] = outcome.value;
      return { status: outcome.status, followUps: [] };
    },
  };
  const started = performance.now();
  const log = await runOnce(spec(concurrent), platform, run);
  return {
    run,
    entries: log.entries,
    lines: log.entries.map(line),
    status,
    value,
    resets,
    ms: performance.now() - started,
  };
}

/** A fault point of a run: a call an effect of the innermost code's made, by what and which. */
export interface Point {
  readonly key: string;
  readonly invocation: string;
  readonly ordinal: number;
  readonly target: string;
  readonly op: string;
}

/** The objects of the outer calls: those calls take no fault, so every variant has the same points. */
const outer = new Set(["a", "m"]);
const isOuterObject = (e: EffectRecord) => e.target === "DO:X" && outer.has(e.op);

/** How the innermost code is reached. */
export interface Variant {
  readonly name: string;
  /** Whether the call to the Worker `w` is one of the outer calls (else it is the innermost). */
  readonly throughWorker: boolean;
  /** The invocation the innermost call is an effect of. */
  readonly caller: (event: string) => string;
  /** The outer objects on the way in from the event's own invocation, innermost first. */
  readonly objects: readonly string[];
  /** The outer objects inside the called Worker's invocation, innermost first. */
  readonly inside: readonly string[];
  readonly wrap: (inner: (k: Kit, event: string) => Promise<unknown>) => typeof inner;
}

const viaWorker = (event: string) => `${event}#1/SVC.w`;
const own = (event: string) => `${event}#1`;
export const direct: Variant = {
  name: "direct",
  throughWorker: false,
  caller: own,
  objects: [],
  inside: [],
  wrap: (inner) => inner,
};
/** The nestings of a call into an object. */
export const aroundObject: Variant[] = [
  {
    name: "inside an object's call",
    throughWorker: false,
    caller: own,
    objects: ["a"],
    inside: [],
    wrap: (inner) => (k, e) => k.call("a", () => inner(k, e)),
  },
  {
    name: "two objects deep",
    throughWorker: false,
    caller: own,
    objects: ["a", "m"],
    inside: [],
    wrap: (inner) => (k, e) => k.call("m", () => k.call("a", () => inner(k, e))),
  },
  {
    name: "inside a called Worker",
    throughWorker: true,
    caller: viaWorker,
    objects: [],
    inside: [],
    wrap: (inner) => (k, e) => k.worker(viaWorker(e), () => inner(k, e)),
  },
  {
    name: "inside a Worker an object called",
    throughWorker: true,
    caller: viaWorker,
    objects: ["a"],
    inside: [],
    wrap: (inner) => (k, e) => k.call("a", () => k.worker(viaWorker(e), () => inner(k, e))),
  },
  {
    name: "inside an object a called Worker called",
    throughWorker: true,
    caller: viaWorker,
    objects: [],
    inside: ["a"],
    wrap: (inner) => (k, e) => k.worker(viaWorker(e), () => k.call("a", () => inner(k, e))),
  },
];
/** The nestings of a call to a Worker (the Worker `w` is the innermost itself). */
export const aroundWorker: Variant[] = aroundObject.filter((v) => !v.throughWorker);

/** The run's effects with the variant's outer calls taken out and its innermost caller named as the direct run's. */
function inner(ran: Ran, variant: Variant, event = "e"): EffectRecord[] {
  return ran.entries
    .filter((e) => !isOuterObject(e) && !(variant.throughWorker && e.target === "Service:SVC"))
    .map((e) => (e.invocation === variant.caller(event) ? { ...e, invocation: own(event) } : e));
}

function points(ran: Ran, variant: Variant): Point[] {
  const ordinals = new Map<string, number>();
  const seen = new Map<string, number>();
  const found: Point[] = [];
  for (const e of ran.entries) {
    if (e.kind !== "call") continue;
    const ordinal = ordinals.get(e.invocation) ?? 0;
    ordinals.set(e.invocation, ordinal + 1);
    if (isOuterObject(e) || (variant.throughWorker && e.target === "Service:SVC")) continue;
    const what = `${e.target} ${e.op}`;
    const nth = (seen.get(what) ?? 0) + 1;
    seen.set(what, nth);
    found.push({
      key: `${what} #${nth}`,
      invocation: e.invocation,
      ordinal,
      target: e.target,
      op: e.op,
    });
  }
  return found;
}

/** A timing: what the innermost code does when called. */
export interface Timing {
  readonly name: string;
  readonly gated?: boolean;
  /** Whether a Worker's handler can be the innermost too: it awaits everything it starts. */
  readonly awaitsAll?: boolean;
  readonly body: (kit: Kit) => unknown | Promise<unknown>;
}

export const quiet = (work: Promise<unknown>): void => void work.catch(() => {});

export const timings: Timing[] = [
  {
    name: "awaits a timer, then makes an effect",
    awaitsAll: true,
    body: async (k) => {
      await sleep(10);
      await k.fetch("GET");
      return "b";
    },
  },
  {
    name: "makes an effect, awaits a timer, makes another",
    awaitsAll: true,
    body: async (k) => {
      await k.fetch("one");
      await sleep(10);
      await k.fetch("two");
      return "b";
    },
  },
  {
    name: "naps three times with an effect after each",
    awaitsAll: true,
    body: async (k) => {
      for (const op of ["one", "two", "three"]) {
        await sleep(5);
        await k.fetch(op);
      }
      return "b";
    },
  },
  {
    name: "awaits a timer and an effect together",
    awaitsAll: true,
    body: async (k) => {
      await Promise.all([sleep(10), k.fetch("GET")]);
      return "b";
    },
  },
  {
    name: "awaits two effects together",
    awaitsAll: true,
    body: async (k) => {
      await Promise.all([k.fetch("one"), k.fetch("two")]);
      return "b";
    },
  },
  {
    name: "answers and goes on, after a timer, with an effect",
    body: (k) => {
      quiet(
        (async () => {
          await sleep(10);
          await k.fetch("later");
        })(),
      );
      return "b";
    },
  },
  {
    name: "answers with a timer set whose callback makes an effect",
    body: (k) => {
      setTimeout(() => quiet(k.fetch("tick")), 10);
      return "b";
    },
  },
  {
    name: "issues an effect it does not await, and answers",
    body: (k) => {
      quiet(k.fetch("stray"));
      return "b";
    },
  },
  {
    name: "makes an effect, issues one it does not await, and goes on after its answer",
    body: async (k) => {
      await k.fetch("first");
      quiet(
        (async () => {
          await k.fetch("stray");
          await sleep(10);
          await k.fetch("later");
        })(),
      );
      return "b";
    },
  },
  {
    name: "holds its gate over a timer and two effects",
    gated: true,
    body: async (k) => {
      await k.fetch("one");
      await sleep(10);
      await k.fetch("two");
      return "b";
    },
  },
  {
    name: "calls a third object, which naps before it answers",
    awaitsAll: true,
    body: async (k) => {
      const c = await k.call(
        "c",
        async () => {
          await sleep(10);
          await k.fetch("deep");
          return "c";
        },
        { allowed: kinds },
      );
      await k.fetch("after");
      return `b:${c}`;
    },
  },
  {
    name: "after its answer calls a third object, which naps before it answers",
    body: (k) => {
      quiet(
        (async () => {
          await sleep(5);
          await k.call(
            "c",
            async () => {
              await sleep(10);
              await k.fetch("deep");
            },
            { allowed: kinds },
          );
          await k.fetch("done");
        })(),
      );
      return "b";
    },
  },
];

/** The innermost call: into the object `b`, or to the Worker `w`. */
export const intoObject = (t: Timing) => (k: Kit) =>
  k.call("b", () => t.body(k), { allowed: kinds, ...(t.gated ? { gated: true } : {}) });
export const toWorker = (t: Timing) => (k: Kit, event: string) =>
  k.worker(viaWorker(event), async () => t.body(k), { allowed: kinds });

export const settled = (ran: Ran, label: string): void => {
  expect(ran.run.unsupportedReasons, label).toEqual([]);
  // A run that waited for something nothing could give ends at the budget.
  expect(ran.ms, label).toBeLessThan(budgetMs / 2);
};

interface DirectRuns {
  readonly none: Ran;
  readonly points: Point[];
  /** By `<fault> at <point>`. */
  readonly faulted: ReadonlyMap<string, Ran>;
}
/** The innermost call a comparison is about: into the object `b`, or to the Worker `w`. */
export type Innermost = "object" | "worker";
const innermostOf = (kind: Innermost, timing: Timing) =>
  kind === "object" ? intoObject(timing) : toWorker(timing);
/**
 * The direct runs of one innermost call in one mode, without a fault and with each fault at each
 * point, made once and each replayed once (the same schedule gives the same run): every variant
 * compares against the same runs. Keyed by the timing itself, so a key names exactly the code run.
 */
const directRuns = new Map<Innermost, WeakMap<Timing, Map<number, Promise<DirectRuns>>>>();
function directOf(concurrent: number, kind: Innermost, timing: Timing): Promise<DirectRuns> {
  const byTiming = directRuns.get(kind) ?? new WeakMap<Timing, Map<number, Promise<DirectRuns>>>();
  directRuns.set(kind, byTiming);
  const byMode = byTiming.get(timing) ?? new Map<number, Promise<DirectRuns>>();
  byTiming.set(timing, byMode);
  let runs = byMode.get(concurrent);
  if (!runs) {
    const innermost = innermostOf(kind, timing);
    const replayed = async (ran: Ran, label: string, faults: readonly Fault[] = []) => {
      const again = await once(concurrent, innermost, { faults });
      expect(again.entries, `direct, ${label}, replayed`).toEqual(ran.entries);
    };
    runs = (async () => {
      const none = await once(concurrent, innermost);
      settled(none, "direct, no fault");
      await replayed(none, "no fault");
      const at = points(none, direct);
      const faulted = new Map<string, Ran>();
      for (const point of at) {
        for (const fault of kinds) {
          const label = `${fault} at ${point.key}`;
          const faults = [{ ...point, fault }];
          const d = await once(concurrent, innermost, { faults });
          settled(d, `direct, ${label}`);
          expect(
            d.lines.some((l) => l.includes(" fault ")),
            label,
          ).toBe(true);
          await replayed(d, label, faults);
          faulted.set(label, d);
        }
      }
      return { none, points: at, faulted };
    })();
    byMode.set(concurrent, runs);
  }
  return runs;
}

/**
 * Run the innermost call `kind` with `timing` inside `variant`, without a fault and with each
 * fault at each point, and compare with its direct runs.
 */
export async function compare(
  concurrent: number,
  kind: Innermost,
  timing: Timing,
  variant: Variant,
): Promise<void> {
  const nested = variant.wrap(innermostOf(kind, timing));
  const { none: d0, points: directPoints, faulted } = await directOf(concurrent, kind, timing);
  const n0 = await once(concurrent, nested);
  settled(n0, "nested, no fault");
  expect(inner(n0, variant).map(line)).toEqual(d0.lines);
  expect(n0.status[variant.caller("e")]).toEqual(d0.status["e#1"]);
  const nestedPoints = points(n0, variant);
  expect(nestedPoints.map((p) => p.key)).toEqual(directPoints.map((p) => p.key));
  for (const [i, at] of directPoints.entries()) {
    const inside = nestedPoints[i];
    if (!inside) throw new Error("the variants' points differ");
    for (const fault of kinds) {
      const label = `${fault} at ${at.key}`;
      const d = faulted.get(label);
      if (!d) throw new Error(`no direct run for ${label}`);
      const n = await once(concurrent, nested, { faults: [{ ...inside, fault }] });
      settled(n, `nested, ${label}`);
      expect(inner(n, variant).map(line), label).toEqual(d.lines);
      expect(n.status[variant.caller("e")], label).toEqual(d.status["e#1"]);
      expect(
        n.resets.filter((r) => !outer.has(r)),
        label,
      ).toEqual(d.resets);
      // A crash inside an object's call ends the invocation the call is an effect of, so every
      // object on the way in from that invocation is reset, innermost first; one that only called
      // the Worker whose invocation crashed is not.
      const expected = [
        ...(n.status[variant.caller("e")] === "crashed" ? variant.inside : []),
        ...(n.status["e#1"] === "crashed" ? variant.objects : []),
      ];
      const out = n.resets.filter((r) => outer.has(r));
      expect(out, label).toEqual(expected);
      if (out.length > 0) expect(n.resets.slice(-out.length), label).toEqual(out);
      // The same schedule gives the same run.
      const again = await once(concurrent, nested, { faults: [{ ...inside, fault }] });
      expect(again.entries, label).toEqual(n.entries);
    }
  }
}

export const modes: [string, number][] = [
  ["one invocation at a time", 1],
  ["two in flight", 2],
];

const twoEvents = [{ id: "e" }, { id: "f" }];
/** Two events through `variant`: every seed without a fault, then each fault at each point of either event; the run ends, and replays. */
export async function ends(
  concurrent: number,
  innermost: (k: Kit, event: string) => Promise<unknown>,
  variant: Variant,
): Promise<void> {
  const handler = variant.wrap(innermost);
  let base: Ran | undefined;
  for (const seed of [1, 2, 3]) {
    const ran = await once(concurrent, handler, { seed, events: twoEvents });
    const label = `${variant.name}, seed ${seed}`;
    settled(ran, label);
    expect(Object.keys(ran.status), label).toContain("f#1");
    expect((await once(concurrent, handler, { seed, events: twoEvents })).entries, label).toEqual(
      ran.entries,
    );
    base ??= ran;
  }
  if (!base) return;
  for (const at of points(base, variant)) {
    for (const fault of kinds) {
      const label = `${variant.name}, ${fault} at ${at.invocation} ${at.key}`;
      const faults = [{ ...at, fault }];
      const ran = await once(concurrent, handler, { events: twoEvents, faults });
      settled(ran, label);
      expect(
        ran.lines.some((l) => l.includes(" fault ")),
        label,
      ).toBe(true);
      expect(
        (await once(concurrent, handler, { events: twoEvents, faults })).entries,
        label,
      ).toEqual(ran.entries);
    }
  }
}

/** The nestings two events go through: an object's (one deep), a called Worker's, and their mixes. */
export const nestings = [direct, ...aroundObject.filter((v) => v.name !== "two objects deep")];
