/**
 * Two events through the same objects, both in flight, where the innermost
 * object awaits everything it starts before it answers: every seed and
 * every fault placement of either event ends, and replays the same. The
 * timings with work past the answer, and the called Workers, are
 * `nested-calls-two-in-flight-after.test.ts`.
 */
import { describe, test } from "vitest";
import { ends, intoObject, nestings, timings } from "./nested-calls.support.ts";

describe("two events through the same objects (two in flight)", () => {
  test.each(timings.filter((t) => t.awaitsAll))(
    "the object $name: every seed and every fault placement ends, and replays the same",
    async (timing) => {
      for (const variant of nestings) await ends(2, intoObject(timing), variant);
    },
    120_000,
  );
});
