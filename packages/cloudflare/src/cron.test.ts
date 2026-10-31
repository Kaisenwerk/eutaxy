/** Cloudflare's cron dialect: five UTC fields, weekdays 1 = Sunday to 7 = Saturday, names, lists, ranges and steps. */
import { virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { cronMatches, cronTicks, parseCron } from "./cron.ts";

const at = (iso: string): number => Date.parse(iso);

describe("parsing", () => {
  test("stars, lists, ranges, steps and names", () => {
    const s = parseCron("*/15 9-17 1,15 jan,JUL mon-fri");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.daysOfMonth]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 7]);
    // Cloudflare numbers Sunday 1, so Monday to Friday are 2 to 6.
    expect([...s.weekdays]).toEqual([2, 3, 4, 5, 6]);
  });

  test("a step from a value runs to the field's end", () => {
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  test("refuses what Cloudflare does not accept, and what is not modelled", () => {
    expect(() => parseCron("* * * *")).toThrow("five fields");
    expect(() => parseCron("60 * * * *")).toThrow("minute: 60 is outside 0-59");
    expect(() => parseCron("* * * * 8")).toThrow("weekday: 8 is outside 1-7");
    expect(() => parseCron("* * * * 0")).toThrow("weekday: 0 is outside 1-7");
    expect(() => parseCron("* * L * *")).toThrow("L, W and # are not modelled");
    expect(() => parseCron("* * * * 6#2")).toThrow("not modelled");
    expect(() => parseCron("10-5 * * * *")).toThrow("runs backwards");
    expect(() => parseCron("*/0 * * * *")).toThrow("step");
    expect(() => parseCron("x * * * *")).toThrow('minute: "x" is not a value');
    expect(() => parseCron("*/5/2 * * * *")).toThrow("is not a value, range or step");
    expect(() => parseCron("1-2-3 * * * *")).toThrow("is not a range");
    expect(() => parseCron("1,,2 * * * *")).toThrow("is not a value, range or step");
  });
});

describe("matching", () => {
  test("the day fields: one restricted must match, both restricted either may (standard cron)", () => {
    // 2026-01-01 is a Thursday (Cloudflare 5).
    const thursday = at("2026-01-01T10:30:00Z");
    expect(cronMatches(parseCron("30 10 * * thu"), thursday)).toBe(true);
    expect(cronMatches(parseCron("30 10 * * fri"), thursday)).toBe(false);
    expect(cronMatches(parseCron("30 10 1 * *"), thursday)).toBe(true);
    expect(cronMatches(parseCron("30 10 2 * *"), thursday)).toBe(false);
    expect(cronMatches(parseCron("30 10 2 * thu"), thursday)).toBe(true);
    expect(cronMatches(parseCron("30 10 1 * fri"), thursday)).toBe(true);
    expect(cronMatches(parseCron("30 10 2 * fri"), thursday)).toBe(false);
  });
});

describe("ticks from the virtual epoch", () => {
  test("every five minutes starts at the epoch itself, the first matching minute", () => {
    expect(cronTicks("*/5 * * * *", virtualEpoch, 3)).toEqual([
      virtualEpoch,
      virtualEpoch + 5 * 60_000,
      virtualEpoch + 10 * 60_000,
    ]);
  });

  test("a daily job at 03:00 on weekdays skips the weekend", () => {
    // 2026-01-02 is a Friday; the next weekday is Monday the 5th.
    expect(
      cronTicks("0 3 * * mon-fri", virtualEpoch, 2).map((t) => new Date(t).toISOString()),
    ).toEqual(["2026-01-01T03:00:00.000Z", "2026-01-02T03:00:00.000Z"]);
    expect(
      cronTicks("0 3 * * mon-fri", at("2026-01-02T04:00:00Z"), 1).map((t) =>
        new Date(t).toISOString(),
      ),
    ).toEqual(["2026-01-05T03:00:00.000Z"]);
  });

  test("an expression that never fires is refused", () => {
    expect(() => cronTicks("0 0 30 feb *", virtualEpoch, 1)).toThrow("never fires");
  });

  test("ticks far apart are all found: the horizon is per match, not for the whole sequence", () => {
    expect(
      cronTicks("0 0 29 feb *", virtualEpoch, 2).map((t) => new Date(t).toISOString()),
    ).toEqual(["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
    expect(cronTicks("0 0 1 jan *", virtualEpoch, 7)).toHaveLength(7);
  });
});
