/**
 * Cloudflare's cron expressions (Workers, Cron Triggers): five fields,
 * minute, hour, day of month, month and weekday, in UTC, with `*`, lists,
 * ranges, steps and names; weekdays run 1 = Sunday to 7 = Saturday. The
 * tick times a scenario drives are the expression's matches from the
 * virtual epoch on, so `scheduledTime` is what the trigger would have set.
 * `L`, `W` and `#` are not modelled: a scenario using them is refused.
 */

const monthNames = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** The number the first name stands for (months start at 1, Cloudflare's weekdays at 1 = Sunday). */
  readonly firstName?: number;
}

const fields: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: monthNames, firstName: 1 },
  { name: "weekday", min: 1, max: 7, names: dayNames, firstName: 1 },
];

/** A parsed expression: the values each field admits. */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 1 = Sunday to 7 = Saturday, as Cloudflare numbers them. */
  readonly weekdays: ReadonlySet<number>;
  /** Whether the day fields were both given: then a day matches either, as cron has it. */
  readonly anyDayOfMonth: boolean;
  readonly anyWeekday: boolean;
}

function value(token: string, field: Field): number {
  const lower = token.toLowerCase();
  if (field.names) {
    const i = field.names.indexOf(lower);
    if (i >= 0) return (field.firstName ?? 0) + i;
  }
  if (!/^\d+$/.test(token))
    throw new Error(`${field.name}: ${JSON.stringify(token)} is not a value`);
  const n = Number(token);
  if (n < field.min || n > field.max)
    throw new Error(`${field.name}: ${n} is outside ${field.min}-${field.max}`);
  return n;
}

function parseField(text: string, field: Field): Set<number> {
  if (/[LW#]/i.test(text) && !field.names?.some((n) => text.toLowerCase().includes(n)))
    throw new Error(`${field.name}: L, W and # are not modelled`);
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2 || part === "")
      throw new Error(`${field.name}: ${JSON.stringify(part)} is not a value, range or step`);
    const [rangeText, stepText] = pieces as [string, string?];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new Error(`${field.name}: step ${JSON.stringify(stepText)} is not a positive number`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = field.min;
      to = field.max;
    } else if (rangeText.includes("-")) {
      const ends = rangeText.split("-");
      if (ends.length !== 2)
        throw new Error(`${field.name}: ${JSON.stringify(rangeText)} is not a range`);
      const [a, b] = ends as [string, string];
      from = value(a, field);
      to = value(b, field);
      if (from > to) throw new Error(`${field.name}: range ${rangeText} runs backwards`);
    } else {
      from = value(rangeText, field);
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parse an expression; throws with the field and the problem when it is not one Cloudflare accepts. */
export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `a cron expression has five fields, got ${parts.length}: ${JSON.stringify(expression)}`,
    );
  const [minute, hour, dom, month, weekday] = parts as [string, string, string, string, string];
  return {
    minutes: parseField(minute, fields[0] as Field),
    hours: parseField(hour, fields[1] as Field),
    daysOfMonth: parseField(dom, fields[2] as Field),
    months: parseField(month, fields[3] as Field),
    weekdays: parseField(weekday, fields[4] as Field),
    anyDayOfMonth: dom === "*",
    anyWeekday: weekday === "*",
  };
}

/** Whether the minute starting at `time` (ms since the epoch, UTC) matches. */
export function cronMatches(schedule: CronSchedule, time: number): boolean {
  const d = new Date(time);
  if (!schedule.minutes.has(d.getUTCMinutes()) || !schedule.hours.has(d.getUTCHours()))
    return false;
  if (!schedule.months.has(d.getUTCMonth() + 1)) return false;
  const dayOk = schedule.daysOfMonth.has(d.getUTCDate());
  const weekdayOk = schedule.weekdays.has(d.getUTCDay() + 1);
  // Both day fields restricted: either may match (standard cron); one restricted: it must.
  if (!schedule.anyDayOfMonth && !schedule.anyWeekday) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

const minuteMs = 60_000;
/**
 * Between two matches of any expression Cloudflare accepts lie at most eight
 * years (the 29th of February across a century's missing leap year); an
 * expression with no match in that span never fires.
 */
const longestGapMs = 9 * 366 * 24 * 60 * minuteMs;

/** The first `count` tick times at or after `from`, each the start of a matching minute. */
export function cronTicks(expression: string, from: number, count: number): number[] {
  const schedule = parseCron(expression);
  const out: number[] = [];
  let t = Math.ceil(from / minuteMs) * minuteMs;
  let horizon = t + longestGapMs;
  while (out.length < count) {
    if (t > horizon) throw new Error(`${JSON.stringify(expression)} never fires`);
    if (cronMatches(schedule, t)) {
      out.push(t);
      horizon = t + longestGapMs;
    }
    t += minuteMs;
  }
  return out;
}
