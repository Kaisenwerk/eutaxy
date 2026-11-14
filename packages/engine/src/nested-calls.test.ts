/**
 * A call made from inside another call: an object calling an object, a
 * called Worker calling an object, an object calling a Worker. Everything a
 * call from the scenario's Worker meets (a timer the called code awaits
 * before it answers, work it goes on with afterwards, an effect it does not
 * await, a fault at any of its effects) it meets nested too, so each timing
 * is run both ways under every fault placement and the two runs are
 * compared: the nested one is the direct one with the outer calls around it.
 * Two events through the same objects are in the other
 * `nested-calls-*.test.ts` files.
 */
import { describe, expect, test } from "vitest";
import {
  aroundObject,
  aroundWorker,
  compare,
  type Kit,
  modes,
  once,
  quiet,
  type Ran,
  settled,
  sleep,
  timings,
} from "./nested-calls.support.ts";

describe.each(modes)("a call into an object, nested as from the Worker (%s)", (_m, concurrent) => {
  describe.each(timings)("the object $name", (timing) => {
    test.each(aroundObject)(
      "$name",
      (variant) => compare(concurrent, "object", timing, variant),
      60_000,
    );
  });
});

describe.each(modes)(
  "a call to a Worker, nested as from the scenario's Worker (%s)",
  (_m, concurrent) => {
    describe.each(timings.filter((t) => t.awaitsAll))("its handler $name", (timing) => {
      test.each(aroundWorker)(
        "$name",
        (variant) => compare(concurrent, "worker", timing, variant),
        60_000,
      );
    });
  },
);

describe.each(modes)("an object awaiting its call into another (%s)", (_m, concurrent) => {
  const nap = async (k: Kit, ms = 10) => {
    await sleep(ms);
    await k.fetch("woke", []);
    return "napped";
  };
  const fine = (ran: Ran, value: unknown): void => {
    settled(ran, "the run");
    expect(ran.status).toEqual({ "e#1": "completed" });
    expect(ran.value["e#1"]).toEqual(value);
  };

  test("its own timers stay its own: they do not fire while the call is in flight", async () => {
    const seen: string[] = [];
    const ran = await once(concurrent, (k) =>
      k.call("a", async () => {
        const timeout = sleep(5).then(() => seen.push("timeout"));
        await k.call("b", () => nap(k));
        seen.push("answered");
        await timeout;
        return seen.join(", ");
      }),
    );
    fine(ran, "answered, timeout");
  });

  test("calling itself: the inner call naps and the outer one goes on", async () => {
    const ran = await once(concurrent, (k) =>
      k.call("a", async () => `outer:${await k.call("a", () => nap(k))}`),
    );
    fine(ran, "outer:napped");
  });

  test("called back by the object it called, while it waits: the call back naps", async () => {
    const ran = await once(concurrent, (k) =>
      k.call("a", async () => {
        const b = await k.call("b", async () => `b:${await k.call("a", () => nap(k))}`);
        return `a:${b}`;
      }),
    );
    fine(ran, "a:b:napped");
  });

  test("from its constructor, on a call's way in: the method runs after the called object woke", async () => {
    const order: string[] = [];
    const ran = await once(concurrent, (k) =>
      k.call(
        "a",
        () => {
          order.push("method");
          return "a";
        },
        {
          entering: async () => {
            order.push(await k.call("b", () => nap(k)));
          },
        },
      ),
    );
    fine(ran, "a");
    expect(order).toEqual(["napped", "method"]);
  });

  test("while holding its gate: the call is made at once and the called object wakes", async () => {
    const ran = await once(concurrent, (k) =>
      k.call("a", async () => `held:${await k.call("b", () => nap(k))}`, { gated: true }),
    );
    fine(ran, "held:napped");
  });

  test("and not awaiting it: the call outlives the answer as the first object's work, and the run waits for it", async () => {
    const ran = await once(concurrent, (k) =>
      k.call("a", () => {
        quiet(k.call("b", () => nap(k)));
        return "a";
      }),
    );
    fine(ran, "a");
    // As an effect the Worker's object issued and did not await: opened during the call in a
    // sequential run, it stays the call's in the trace; parked when the answer crossed, it is the
    // object's own turn.
    const owner = concurrent === 1 ? "e#1" : "DO:X/a/after";
    expect(ran.lines.slice(-3)).toEqual([
      `${owner} call Fetch:api woke`,
      `${owner} result Fetch:api woke`,
      `${owner} result DO:X b`,
    ]);
  });

  test("three objects deep with a nap at each level", async () => {
    const ran = await once(concurrent, (k) =>
      k.call("a", async () => {
        await sleep(5);
        const b = await k.call("b", async () => {
          await sleep(5);
          const c = await k.call("c", () => nap(k, 5));
          await sleep(5);
          return `b:${c}`;
        });
        await sleep(5);
        return `a:${b}`;
      }),
    );
    fine(ran, "a:b:napped");
  });
});
