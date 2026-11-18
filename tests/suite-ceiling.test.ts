/**
 * The suite's ceiling (tests/suite-ceiling.ts): a run above it fails and names its slowest files,
 * a run at or below it passes, and the ceiling comes only from the environment the check job sets.
 */
import { expect, test } from "vitest";
import { ceilingFrom, ceilingVerdict, slowestShown } from "./suite-ceiling.ts";

const files = Array.from({ length: 12 }, (_, i) => ({
  file: `tests/f${i}.test.ts`,
  ms: (i + 1) * 1000,
}));

test("a run at or below the ceiling passes", () => {
  expect(ceilingVerdict(420_000, files, 420)).toEqual({ ok: true });
});

test("a run above it fails, naming its slowest files, slowest first", () => {
  const verdict = ceilingVerdict(421_500, files, 420);
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  const lines = verdict.message.trimEnd().split("\n");
  expect(lines[0]).toBe(
    "The test suite took 421.5 s, above its ceiling of 420 s (docs/roadmap.md, v0.18). Its slowest files:",
  );
  expect(lines.slice(1)).toHaveLength(slowestShown);
  expect(lines[1]).toBe("  12.0 s  tests/f11.test.ts");
  expect(lines.at(-1)).toBe("   3.0 s  tests/f2.test.ts");
});

test("the ceiling is read from the environment, and nothing else turns it on", () => {
  expect(ceilingFrom(undefined)).toBeUndefined();
  expect(ceilingFrom("")).toBeUndefined();
  expect(ceilingFrom("420")).toBe(420);
  expect(() => ceilingFrom("seven minutes")).toThrow(
    'EUTAXY_SUITE_CEILING_S must be a positive number of seconds, got "seven minutes"',
  );
});
