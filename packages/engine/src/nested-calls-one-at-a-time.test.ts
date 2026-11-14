/**
 * Two events through the same objects, one invocation at a time: for each
 * timing of the innermost call and each nesting, every seed and every fault
 * placement of either event ends, and replays the same. One event, nested
 * and direct compared, is `nested-calls.test.ts`.
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

describe("two events through the same objects (one invocation at a time)", () => {
  test.each(timings)(
    "the object $name: every seed and every fault placement ends, and replays the same",
    async (timing) => {
      for (const variant of nestings) await ends(1, intoObject(timing), variant);
    },
    120_000,
  );

  test.each(timings.filter((t) => t.awaitsAll))(
    "a called Worker whose handler $name: every seed and every fault placement ends, and replays the same",
    async (timing) => {
      for (const variant of [direct, ...aroundWorker]) await ends(1, toWorker(timing), variant);
    },
    120_000,
  );
});
