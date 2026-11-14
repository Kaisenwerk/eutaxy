/**
 * Two events through the same objects, both in flight: the timings where
 * the innermost object's work goes on past its answer or holds its gate,
 * and the called Workers' handlers. Every seed and every fault placement of
 * either event ends, and replays the same.
 */
import { describe, test } from "vitest";
import {
  aroundWorker,
  direct,
  ends,
  intoObject,
  nestings,
  timings,
  toWorker,
} from "./nested-calls.support.ts";

describe("two events through the same objects (two in flight)", () => {
  test.each(timings.filter((t) => !t.awaitsAll))(
    "the object $name: every seed and every fault placement ends, and replays the same",
    async (timing) => {
      for (const variant of nestings) await ends(2, intoObject(timing), variant);
    },
    120_000,
  );

  test.each(timings.filter((t) => t.awaitsAll))(
    "a called Worker whose handler $name: every seed and every fault placement ends, and replays the same",
    async (timing) => {
      for (const variant of [direct, ...aroundWorker]) await ends(2, toWorker(timing), variant);
    },
    120_000,
  );
});
