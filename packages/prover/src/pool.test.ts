import { describe, expect, test } from "vitest";
import { inPool } from "./pool.ts";

/** A promise settled by hand, so a test decides the order jobs finish in. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("inPool", () => {
  test("results are in item order, whatever order the jobs finish in", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const run = inPool([0, 1, 2], 3, async (i) => {
      await gates[i]?.promise;
      return `r${i}`;
    });
    gates[2]?.resolve();
    gates[0]?.resolve();
    gates[1]?.resolve();
    expect(await run).toEqual(["r0", "r1", "r2"]);
  });

  test("at most limit jobs run at once", async () => {
    let running = 0;
    let most = 0;
    await inPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running++;
      most = Math.max(most, running);
      await Promise.resolve();
      running--;
    });
    expect(most).toBe(3);
  });

  test("no items is no results; a limit below one still runs the jobs", async () => {
    expect(await inPool([], 4, async () => 1)).toEqual([]);
    expect(await inPool(["a", "b"], 0, async (x, i) => `${x}${i}`)).toEqual(["a0", "b1"]);
  });

  test("a job that throws rejects the pool, and no job is started after it", async () => {
    await expect(
      inPool([1, 2], 2, async (x) => {
        if (x === 2) throw new Error("two");
        return x;
      }),
    ).rejects.toThrow("two");
    const started: number[] = [];
    await expect(
      inPool([1, 2, 3, 4, 5], 1, async (x) => {
        started.push(x);
        if (x === 2) throw new Error("two");
      }),
    ).rejects.toThrow("two");
    expect(started).toEqual([1, 2]);
  });
});
