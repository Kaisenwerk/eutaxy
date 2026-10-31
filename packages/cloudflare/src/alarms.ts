/**
 * Durable Object alarms in virtual time. Eutaxy takes over each object's
 * alarm methods (on its storage and inside transactions), so the runtime
 * never schedules an alarm on the real clock, whose time is far ahead of
 * the virtual one. A set alarm is kept per object, so it survives eviction
 * as a real one does, and becomes an event due at its virtual time; when
 * the run reaches it, the object's `alarm()` handler runs as one effect.
 *
 * Semantics, as Cloudflare documents them (developers.cloudflare.com/
 * durable-objects/api/base/#alarm): an object has one alarm, a later
 * `setAlarm` replaces it, execution is at least once, and a handler that
 * throws is retried with exponential backoff starting at two seconds, up to
 * six retries, with `{ retryCount, isRetry }`. `setAlarm` inside a
 * transaction takes effect only if the transaction commits.
 */

import {
  type DeliveryResult,
  type EventRef,
  type JsonValue,
  type RunHooks,
  readFaults,
  redelivery,
} from "@eutaxy/core";
import { CrashSignal } from "@eutaxy/engine";

/** `EventRef.source` of an alarm event. */
export const alarmSource = "durable_object_alarm";

/** Cloudflare retries a failed alarm handler up to six times, after 2 s, 4 s, 8 s, ... */
const maxRetries = 6;
const firstRetryMs = 2_000;

/** One object's alarm, kept across its instances for the run. */
interface AlarmEntry {
  time: number | null;
  /** Alarm changes for this object so far, for unique event ids. */
  seq: number;
  /**
   * The current alarm's generation: every setAlarm or deleteAlarm starts a
   * new one, and an event or retry of an older generation is superseded.
   */
  gen: number;
  /** Times the alarm fired this run (retries not counted). */
  firings: number;
}

/** What an alarm event carries. */
interface AlarmData {
  readonly binding: string;
  readonly gen: number;
  readonly id: string;
  readonly object: string;
  readonly time: number;
  readonly retryCount: number;
}

/** The alarms of one namespace's objects; the platform clears it before each run. */
export class AlarmBook {
  private readonly entries = new Map<string, AlarmEntry>();

  clear(): void {
    this.entries.clear();
  }

  entry(id: string): AlarmEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { time: null, seq: 0, gen: 0, firings: 0 };
      this.entries.set(id, e);
    }
    return e;
  }
}

/** The alarm of one object, as its taken-over methods see it. */
export interface AlarmControl {
  get(): number | null;
  set(time: number): void;
  delete(): void;
  /** Report something about the object's alarms that Eutaxy cannot model faithfully. */
  unsupported(reason: string): void;
}

/** One alarm control per object: setting schedules an event at the alarm's virtual time. */
export function alarmControl(
  book: AlarmBook,
  binding: string,
  id: string,
  object: string,
  hooks: () => RunHooks,
): AlarmControl {
  const entry = book.entry(id);
  return {
    get: () => entry.time,
    set: (time) => {
      entry.time = time;
      entry.seq++;
      entry.gen = entry.seq;
      const data: AlarmData = { binding, gen: entry.gen, id, object, time, retryCount: 0 };
      const now = Date.now();
      hooks().enqueue({
        id: `alarm:${binding}:${object}:${entry.seq}`,
        attempt: 1,
        source: alarmSource,
        data: data as unknown as JsonValue,
        ...(time > now ? { at: time } : {}),
      });
    },
    delete: () => {
      entry.time = null;
      // Supersedes the pending event and any retry of it.
      entry.seq++;
      entry.gen = entry.seq;
    },
    unsupported: (reason) => hooks().unsupported(`Durable Object ${binding} ${object}: ${reason}`),
  };
}

/** Storage objects whose alarm methods Eutaxy has taken over (one per live instance). */
export const takenOver = new WeakSet<object>();

const timeOf = (time: number | Date) => (typeof time === "number" ? time : time.getTime());

/** Storage objects whose alarm was read before Eutaxy took them over (in a constructor). */
const readBeforeTakeover = new WeakSet<object>();
/** Storage prototypes whose getAlarm records such reads. */
const watched = new WeakSet<object>();

/**
 * Record reads of the native alarm on storage not yet taken over: a rebuilt
 * object's constructor reads native storage, where Eutaxy's pending alarm is
 * not. The wrapper only records; it returns what the native method returns.
 */
function watchReads(storage: DurableObjectStorage): void {
  const proto = Object.getPrototypeOf(storage) as { getAlarm?: (...a: unknown[]) => unknown };
  if (!proto || watched.has(proto) || typeof proto.getAlarm !== "function") return;
  watched.add(proto);
  const native = proto.getAlarm;
  proto.getAlarm = function (this: object, ...args: unknown[]) {
    if (!takenOver.has(this)) readBeforeTakeover.add(this);
    return native.apply(this, args);
  };
}

/**
 * Replace an object's alarm methods so no real alarm is ever scheduled. An
 * alarm the object set before the takeover (in its constructor) is moved
 * over: deleted from the runtime and set on the control, unless an alarm is
 * still pending, which the constructor could not see in native storage
 * (Eutaxy keeps it): then the pending one stays and the run is UNSUPPORTED.
 */
export async function takeOverAlarms(
  storage: DurableObjectStorage,
  alarm: AlarmControl,
): Promise<void> {
  if (takenOver.has(storage)) return;
  // From the first takeover on, later instances' constructor reads are recorded.
  watchReads(storage);
  takenOver.add(storage);
  if (readBeforeTakeover.has(storage) && alarm.get() !== null) {
    alarm.unsupported(
      "its constructor read the alarm while one was pending; natively it would have seen that alarm, so constructors that read the alarm are not modelled",
    );
  }
  const existing = await storage.getAlarm();
  if (existing !== null) {
    await storage.deleteAlarm();
    if (alarm.get() === null) alarm.set(existing);
    else
      alarm.unsupported(
        "its constructor set an alarm while one was pending; natively it would have seen that alarm, so constructors that read the alarm are not modelled",
      );
  }
  const s = storage as unknown as Record<string, unknown>;
  // Inside transactionSync an alarm change would have to roll back with it: not modelled.
  let inSync = false;
  const outsideSync = (op: string) => {
    if (inSync) alarm.unsupported(`${op} inside transactionSync() is not modelled`);
  };
  Object.assign(s, {
    setAlarm: async (time: number | Date) => {
      outsideSync("setAlarm");
      alarm.set(timeOf(time));
    },
    getAlarm: async () => alarm.get(),
    deleteAlarm: async () => {
      outsideSync("deleteAlarm");
      alarm.delete();
    },
  });
  if (typeof s["transactionSync"] === "function") {
    const transactionSync = (s["transactionSync"] as (cb: () => unknown) => unknown).bind(storage);
    s["transactionSync"] = (callback: () => unknown) => {
      inSync = true;
      try {
        return transactionSync(callback);
      } finally {
        inSync = false;
      }
    };
  }
  const transaction = (
    s["transaction"] as (cb: (txn: unknown) => unknown) => Promise<unknown>
  ).bind(storage);
  // Inside a transaction an alarm change is held until the transaction commits.
  s["transaction"] = async (callback: (txn: unknown) => unknown) => {
    // Per attempt: the runtime may run the callback again after a conflict, discarding the first.
    let pending: { time: number | null } | undefined;
    let rolledBack = false;
    const held = {
      setAlarm: async (time: number | Date) => {
        pending = { time: timeOf(time) };
      },
      getAlarm: async () => (pending ? pending.time : alarm.get()),
      deleteAlarm: async () => {
        pending = { time: null };
      },
    };
    const result = await transaction((txn) => {
      pending = undefined;
      rolledBack = false;
      return callback(
        new Proxy(txn as Record<string, unknown>, {
          get(target, prop) {
            if (typeof prop === "string" && prop in held) return held[prop as keyof typeof held];
            const value = target[prop as string];
            if (prop === "rollback" && typeof value === "function") {
              return (...args: unknown[]) => {
                rolledBack = true;
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            // Native methods check their receiver: call them on the real transaction.
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
    });
    if (pending && !rolledBack) {
      if (pending.time === null) alarm.delete();
      else alarm.set(pending.time);
    }
    return result;
  };
}

export interface AlarmDelivery {
  readonly binding: string;
  readonly book: AlarmBook;
  /** Alarm firings allowed per object per run; later ones are recorded and not fired. */
  readonly limit: number;
  /** Run the handler inside the object, after taking over its alarms. */
  readonly runAlarm: (
    id: string,
    object: string,
    info: { readonly retryCount: number; readonly isRetry: boolean },
    gen: number,
  ) => Promise<void>;
  /** Record a platform action (an alarm not fired, a handler given up on). */
  readonly bookkeep: (op: string, args: JsonValue) => void;
  /** Reset the object, when the alarm's invocation crashes inside its handler. */
  readonly abort: (id: string) => void;
  /** Whether an effect the handler makes may wait for a turn (not inside blockConcurrencyWhile). */
  readonly mayPark: (id: string) => boolean;
  /** Drop the object's instance, when its alarm invocation crashed around the handler. */
  readonly evict: (id: string) => Promise<void>;
}

/**
 * Fire an alarm event: skip it when the object's alarm has since moved or
 * been deleted, run `alarm()` as one effect otherwise, and schedule a retry
 * with backoff when the handler fails, crashes, or a fault says it did.
 */
export async function deliverAlarm(
  event: EventRef,
  hooks: RunHooks,
  maxRedeliveries: number,
  d: AlarmDelivery,
): Promise<DeliveryResult> {
  const a = event.data as unknown as AlarmData;
  const entry = d.book.entry(a.id);
  // Superseded by a later setAlarm or deleteAlarm: dropped before anything, faults included.
  if (entry.gen !== a.gen) return { status: "completed", followUps: [] };
  if (a.retryCount === 0) {
    if (entry.time !== a.time) return { status: "completed", followUps: [] };
    // It stays set until the handler starts (runAlarm clears it after the takeover), as natively.
    if (entry.firings >= d.limit) {
      entry.time = null;
      d.bookkeep("alarm_not_fired", { object: a.object, firings: entry.firings });
      return { status: "completed", followUps: [] };
    }
    entry.firings++;
  }
  const invocation = `${event.id}#${event.attempt}`;
  const inv = hooks.startInvocation(invocation);
  const info = { retryCount: a.retryCount, isRetry: a.retryCount > 0 };
  const outcome = hooks
    .effect(
      {
        invocation,
        target: `DO:${d.binding}`,
        op: "alarm",
        args: { object: a.object, retryCount: a.retryCount },
        // Crash before: the handler never ran. Crash after: it ran and committed, but counts as failed.
        allowed: readFaults,
        hostsEffects: true,
      },
      async () => {
        await d.runAlarm(a.id, a.object, info, a.gen);
        return null;
      },
      () => null,
      { onAbandon: () => d.abort(a.id), mayPark: () => d.mayPark(a.id) },
    )
    .then(
      () => "completed" as const,
      (err: unknown) => (err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const)),
    );
  const status = await Promise.race([
    hooks.settle(outcome, invocation),
    inv.crashed.then(() => "crashed" as const),
  ]);
  // A crash is the object's: its in-memory state goes with the instance, whatever the handler did.
  if (status === "crashed") await d.evict(a.id);
  if (status !== "completed") {
    // The retries so far are the attempt less one: retryCount counts them too.
    const next = redelivery(event, maxRetries, { maxRedeliveries });
    if (next) {
      const retryAt = Date.now() + firstRetryMs * 2 ** a.retryCount;
      const data: AlarmData = { ...a, retryCount: a.retryCount + 1 };
      // The alarm stays set, for its retry, until a later change supersedes it.
      if (entry.gen === a.gen) entry.time = retryAt;
      hooks.enqueue({ ...next, data: data as unknown as JsonValue, at: retryAt });
    } else {
      // Given up on: no longer pending, unless a newer alarm replaced it meanwhile.
      if (entry.gen === a.gen) entry.time = null;
      d.bookkeep("alarm_gave_up", { object: a.object, retries: a.retryCount });
    }
  }
  return { status, followUps: [] };
}
