import { describe, expect, test } from "vitest";
import {
  patchGlobals,
  realTick,
  settleOn,
  VirtualClock,
  VirtualRandom,
  virtualEpoch,
} from "./clock.ts";

// Captured before any test patches the globals, so a test can wait on real time.
const realSetTimeoutForTest = globalThis.setTimeout.bind(globalThis);

describe("VirtualClock", () => {
  test("starts at the epoch, advances on demand, and fires timers in due order", () => {
    const c = new VirtualClock();
    expect(c.now()).toBe(virtualEpoch);
    const fired: string[] = [];
    c.setTimeout(() => fired.push("b"), 20);
    c.setTimeout(() => fired.push("a"), 10);
    const id = c.setTimeout(() => fired.push("never"), 15);
    c.clear(id);
    expect(c.fireNext()).toBe(true);
    expect(c.now()).toBe(virtualEpoch + 10);
    expect(c.fireNext()).toBe(true);
    expect(c.now()).toBe(virtualEpoch + 20);
    expect(c.fireNext()).toBe(false);
    expect(fired).toEqual(["a", "b"]);
  });

  test("timers belong to the invocation running when they were scheduled and die with it", () => {
    const c = new VirtualClock();
    const fired: string[] = [];
    c.owner = "msg-1#1";
    c.setTimeout(() => fired.push("from crashed attempt"), 10);
    c.owner = "msg-1#2";
    c.setTimeout(() => fired.push("from retry"), 10);
    c.cancelOwner("msg-1#1");
    expect(c.pendingTimers()).toBe(1);
    expect(c.fireNext()).toBe(true);
    expect(c.fireNext()).toBe(false);
    expect(fired).toEqual(["from retry"]);
  });

  test("intervals reschedule and callbacks that throw do not stop the clock", () => {
    const c = new VirtualClock();
    let n = 0;
    c.setInterval(() => {
      n++;
      if (n === 2) throw new Error("boom");
    }, 5);
    expect(c.fireNext()).toBe(true);
    expect(c.fireNext()).toBe(true);
    expect(c.fireNext()).toBe(true);
    expect(n).toBe(3);
    expect(c.now()).toBe(virtualEpoch + 15);
  });
});

describe("VirtualRandom", () => {
  test("is deterministic per seed and produces v4 UUIDs", () => {
    const a = new VirtualRandom("s");
    const b = new VirtualRandom("s");
    const c = new VirtualRandom("t");
    expect(a.float()).toBe(b.float());
    expect(a.uuid()).toBe(b.uuid());
    expect(a.uuid()).not.toBe(c.uuid());
    expect(new VirtualRandom(1).uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const bytes = new VirtualRandom(2).fill(new Uint8Array(7));
    expect(bytes.length).toBe(7);
    expect(new VirtualRandom(2).fill(new Uint8Array(7))).toEqual(bytes);
  });
});

describe("patchGlobals", () => {
  test("replaces Date, Math.random, crypto and timers for the run and restores them", async () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const realSetTimeout = setTimeout;
    const patched = patchGlobals("seed");
    try {
      expect(Date.now()).toBe(virtualEpoch);
      // biome-ignore lint/complexity/useDateNow: the Date constructor itself is under test
      expect(new Date().getTime()).toBe(virtualEpoch);
      expect(new Date(5).getTime()).toBe(5);
      expect(Date()).toBe(new Date(virtualEpoch).toString());
      expect(Date.UTC(2020, 0, 1)).toBe(1577836800000);
      expect(new Date(0) instanceof Date).toBe(true);
      expect(Math.random()).toBe(new VirtualRandom("seed").float());
      expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
      expect(performance.now()).toBe(0);
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 100);
      expect(fired).toBe(false);
      expect(patched.clock.fireNext()).toBe(true);
      expect(fired).toBe(true);
      expect(Date.now()).toBe(virtualEpoch + 100);
    } finally {
      patched.restore();
    }
    expect(Date.now).toBe(realNow);
    expect(Math.random).toBe(realRandom);
    expect(setTimeout).toBe(realSetTimeout);
    expect(Date.now()).toBeGreaterThan(virtualEpoch);
    patched.restore(); // idempotent
  });
});

describe("libraryIo", () => {
  test("a library timer inside the I/O is real; a handler timer scheduled meanwhile stays virtual", async () => {
    const patched = patchGlobals("io");
    try {
      let handlerFired = false;
      const io = patched.libraryIo(
        () => new Promise<string>((r) => setTimeout(() => r("backed off"), 5)),
      );
      // The handler goes on before awaiting the effect (Codex's case): its timer is virtual.
      setTimeout(() => {
        handlerFired = true;
      }, 50);
      await expect(io).resolves.toBe("backed off");
      expect(handlerFired).toBe(false);
      expect(patched.clock.pendingTimers()).toBe(1);
      expect(Date.now()).toBe(virtualEpoch);
    } finally {
      patched.restore();
    }
  });

  test("overlapping effects each keep real timers for their own library code", async () => {
    const patched = patchGlobals("overlap");
    try {
      const wait = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));
      await Promise.all([patched.libraryIo(() => wait(4)), patched.libraryIo(() => wait(2))]);
      expect(patched.clock.pendingTimers()).toBe(0);
    } finally {
      patched.restore();
    }
  });

  test("a handler continuation after the awaited effect schedules virtual timers again", async () => {
    const patched = patchGlobals("continuation");
    try {
      await patched.libraryIo(() => Promise.resolve());
      setTimeout(() => {}, 1);
      expect(patched.clock.pendingTimers()).toBe(1);
    } finally {
      patched.restore();
    }
  });
});

describe("timer cancellation across library I/O", () => {
  test("a virtual timer can be cancelled from inside the library's I/O", async () => {
    const patched = patchGlobals("cancel-virtual");
    try {
      const id = setTimeout(() => {}, 5);
      await patched.libraryIo(async () => {
        clearTimeout(id);
      });
      expect(patched.clock.pendingTimers()).toBe(0);
    } finally {
      patched.restore();
    }
  });

  test("a real timer the library scheduled can be cancelled from handler code after the I/O", async () => {
    const patched = patchGlobals("cancel-real");
    let fired = false;
    try {
      const id = await patched.libraryIo(async () =>
        setTimeout(() => {
          fired = true;
        }, 1),
      );
      clearTimeout(id);
      await new Promise<void>((r) => realSetTimeoutForTest(() => r(), 5));
      expect(fired).toBe(false);
      expect(patched.clock.pendingTimers()).toBe(0);
    } finally {
      patched.restore();
    }
  });
});

describe("settleOn", () => {
  function ctx(clock: VirtualClock, extra: Partial<{ inFlight: number; crashed: boolean }> = {}) {
    const stuck: string[] = [];
    return {
      stuck,
      ctx: {
        clock,
        inFlight: () => extra.inFlight ?? 0,
        crashed: () => extra.crashed ?? false,
        stuck: () => stuck.push("stuck"),
      },
    };
  }

  test("fires timers while idle so a virtual sleep completes", async () => {
    const clock = new VirtualClock();
    const { ctx: c, stuck } = ctx(clock);
    const slept = new Promise<string>((resolve) => clock.setTimeout(() => resolve("woke"), 5000));
    await expect(settleOn(slept, c)).resolves.toBe("woke");
    expect(clock.now()).toBe(virtualEpoch + 5000);
    expect(stuck).toEqual([]);
  });

  test("rejects with the promise's error and reports a stuck wait", async () => {
    const clock = new VirtualClock();
    await expect(settleOn(Promise.reject(new Error("no")), ctx(clock).ctx)).rejects.toThrow("no");
    const { ctx: c, stuck } = ctx(clock);
    const never = new Promise<never>(() => {});
    const race = await Promise.race([
      settleOn(never, c).then(() => "settled"),
      realTick()
        .then(() => realTick())
        .then(() => "tick"),
    ]);
    expect(race).toBe("tick");
    expect(stuck).toEqual(["stuck"]);
  });
});
