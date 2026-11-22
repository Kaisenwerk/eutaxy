/**
 * The arithmetic of the run-cost gate (scripts/run-cost.ts): a run's cost is the time a check of
 * many runs takes beyond a check of one, and the gate holds while the ratio of the two scenarios'
 * costs stays at or under its limit, read again when a reading is above it. The measurement itself
 * runs in the check job, after the suite.
 */
import { expect, test } from "vitest";
import {
  least,
  limit,
  perRun,
  type Reading,
  readings,
  runs,
  settle,
  verdict,
} from "../scripts/run-cost.ts";

test("a run costs the time beyond a check of one run, over the runs added", () => {
  expect(runs).toBe(101);
  expect(perRun({ one: 3000, many: 9100 })).toBe(61);
  // A longer check that came out shorter is noise, not a negative cost.
  expect(perRun({ one: 3000, many: 2900 })).toBe(0);
});

test("the gate holds at its limit and fails above it", () => {
  const ordinary = { one: 1500, many: 2300 }; // 8 ms a run
  expect(verdict({ one: 3000, many: 3000 + 100 * 8 * limit }, ordinary)).toMatchObject({
    ratio: limit,
    ok: true,
  });
  expect(verdict({ one: 3000, many: 3000 + 100 * 8 * limit + 100 }, ordinary).ok).toBe(false);
  // An ordinary run that cost nothing measurable cannot vouch for anything.
  expect(verdict({ one: 3000, many: 9000 }, { one: 1500, many: 1500 }).ok).toBe(false);
});

/** A source of readings that hands out `given` in turn, and counts how many were asked for. */
function scripted(given: readonly Reading[]): { read: () => Reading; asked: () => number } {
  let asked = 0;
  return {
    read: () => {
      const next = given[asked++];
      if (next === undefined) throw new Error(`reading ${asked} was not expected`);
      return next;
    },
    asked: () => asked,
  };
}

/** A quiet reading on the CI runner: 78.5 ms against 8.5 ms a run, a ratio of 9.24. */
const quiet: Reading = {
  object: { one: 3000, many: 10850 },
  ordinary: { one: 1500, many: 2350 },
};

/**
 * The shape of the reading that failed on unchanged code: 91.0 ms against 6.9 ms, above the limit.
 * Load made the object's long check slower and the ordinary scenario's check of one run slower, at
 * once.
 */
const loaded: Reading = {
  object: { one: 3000, many: 12100 },
  ordinary: { one: 1660, many: 2350 },
};

test("the least of two readings is the least of each timing", () => {
  expect(
    least(
      { object: { one: 3100, many: 10850 }, ordinary: { one: 1500, many: 2500 } },
      { object: { one: 3000, many: 12100 }, ordinary: { one: 1660, many: 2350 } },
    ),
  ).toEqual(quiet);
});

test("a reading under the limit is the gate's answer, with nothing read again", () => {
  const source = scripted([quiet]);
  expect(settle(source.read)).toMatchObject({ ok: true, taken: 1 });
  expect(source.asked()).toBe(1);
});

test("a reading above the limit on a loaded machine is read again, and the quiet one answers", () => {
  expect(verdict(loaded.object, loaded.ordinary).ok).toBe(false);
  const source = scripted([loaded, quiet]);
  const settled = settle(source.read);
  expect(settled).toMatchObject({ ok: true, taken: 2 });
  expect(settled.ratio).toBeCloseTo(7850 / 850, 10);
  expect(source.asked()).toBe(2);
});

test("load on different timings in each reading does not add up", () => {
  // The object's long check was slow in the first reading, the ordinary check of one run in the
  // second: each alone is above the limit, and the least of each timing is the quiet reading.
  const first: Reading = { object: { one: 3000, many: 13400 }, ordinary: quiet.ordinary };
  const second: Reading = { object: quiet.object, ordinary: { one: 1750, many: 2350 } };
  expect(verdict(first.object, first.ordinary).ok).toBe(false);
  expect(verdict(second.object, second.ordinary).ok).toBe(false);
  expect(settle(scripted([first, second]).read)).toMatchObject({ ok: true, taken: 2 });
});

test("readings that all come out above the limit fail the gate, which stops at its last", () => {
  expect(readings).toBe(3);
  // A third dearer than the quiet reading: 104.7 ms against 8.5 ms.
  const dearer: Reading = { object: { one: 3000, many: 13470 }, ordinary: quiet.ordinary };
  const source = scripted(Array.from({ length: readings }, () => dearer));
  const settled = settle(source.read);
  expect(settled).toMatchObject({ ok: false, taken: readings });
  expect(settled.ratio).toBeGreaterThan(limit);
  expect(source.asked()).toBe(readings);
});

test("a later reading under the limit does not settle the gate while the least of each timing is above", () => {
  // 91.0 ms against 7.0 ms, then 82.0 ms against 8.5 ms: the second is under the limit by itself,
  // but the first showed the ordinary scenario's long check to take 2200 ms, so the gate holds
  // 85.0 ms against 7.0 ms and reads again.
  const first: Reading = {
    object: { one: 3000, many: 12100 },
    ordinary: { one: 1500, many: 2200 },
  };
  const second: Reading = { object: { one: 3300, many: 11500 }, ordinary: quiet.ordinary };
  expect(verdict(second.object, second.ordinary).ok).toBe(true);
  const told: { taken: number; reading: Reading; ratio: number; ok: boolean }[] = [];
  const settled = settle(scripted([first, second, quiet]).read, (taken, reading, held) =>
    told.push({ taken, reading, ratio: held.ratio, ok: held.ok }),
  );
  expect(settled).toMatchObject({ ok: true, taken: 3 });
  expect(settled.ratio).toBeCloseTo(7850 / 700, 10);
  // Each reading is reported as it was taken, with the verdict the gate holds after it.
  expect(told.map((t) => t.taken)).toEqual([1, 2, 3]);
  expect(told.map((t) => t.reading)).toEqual([first, second, quiet]);
  expect(told.map((t) => t.ok)).toEqual([false, false, true]);
  expect(told[0]?.ratio).toBeCloseTo(9100 / 700, 10);
  expect(told[1]?.ratio).toBeCloseTo(8500 / 700, 10);
});
