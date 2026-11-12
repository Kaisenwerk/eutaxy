/** The scheduler's own questions about what is parked, asked without a run. */
import { describe, expect, test } from "vitest";
import { seededChooser } from "./chooser.ts";
import { Frames } from "./frames.ts";
import { Turns } from "./turns.ts";

const turner = (id: string) => ({ id, parks: 0, isCrashed: () => false });

describe("Turns.parkedFor", () => {
  test("a host's work after an answer is told by the end of its invocation's id, whatever the host is named", () => {
    const turns = new Turns(
      seededChooser(1, { faultProbability: 0, maxFaultsPerRun: 0 }),
      new Frames(),
      () => {},
      () => undefined,
    );
    // An object named "after": its host ends as a continuation's id does.
    turns.park(turner("DO:X/after/after"), "Fetch:api", () => {});
    expect(turns.parkedFor(new Set(["DO:X/after"]))).toBe(true);
    expect(turns.parkedFor(new Set(["DO:X"]))).toBe(false);
    // The work of a later instance of the object.
    turns.park(turner("DO:Y/y/after#2"), "Fetch:api", () => {});
    expect(turns.parkedFor(new Set(["DO:Y/y"]))).toBe(true);
    expect(turns.parkedFor(new Set(["DO:Y"]))).toBe(false);
    // An invocation that is nobody's work after an answer.
    turns.park(turner("req-1#1"), "Fetch:api", () => {});
    expect(turns.parkedFor(new Set(["req-1#1", "DO:Z/z"]))).toBe(false);
  });
});
