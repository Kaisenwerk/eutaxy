/**
 * The one redelivery rule, held to the four forms the platforms wrote
 * before it existed, over every small combination of attempt and limits.
 */
import { describe, expect, test } from "vitest";
import type { EventRef } from "./platform.ts";
import { redelivery } from "./redelivery.ts";

const event = (attempt: number): EventRef => ({
  id: "m1",
  attempt,
  data: { orderId: "o-1" },
  at: 5_000,
  source: "test",
});

describe("redelivery", () => {
  test("the next attempt keeps everything but the attempt, which counts up by one", () => {
    expect(redelivery(event(1), 3, { maxRedeliveries: 2 })).toEqual({ ...event(1), attempt: 2 });
  });

  test("stops at whichever is reached first, the platform's limit or the scenario's bound", () => {
    expect(redelivery(event(3), 2, { maxRedeliveries: 9 })).toBeNull();
    expect(redelivery(event(3), 9, { maxRedeliveries: 2 })).toBeNull();
    expect(redelivery(event(3), 3, { maxRedeliveries: 3 })).not.toBeNull();
    expect(redelivery(event(1), 0, { maxRedeliveries: 9 })).toBeNull();
    expect(redelivery(event(1), 9, { maxRedeliveries: 0 })).toBeNull();
  });

  test("agrees with every form the platforms wrote it in", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      for (let limit = 0; limit <= 5; limit++) {
        for (let maxRedeliveries = 0; maxRedeliveries <= 5; maxRedeliveries++) {
          const again = redelivery(event(attempt), limit, { maxRedeliveries }) !== null;
          // Queues: redelivered while attempt <= max_retries.
          expect(again).toBe(attempt <= limit && attempt - 1 < maxRedeliveries);
          // The HTTP caller: resends while the resends so far are under its retries.
          expect(again).toBe(attempt - 1 < limit && attempt - 1 < maxRedeliveries);
          // SQS: delivered while attempt < maxReceiveCount, which counts the first delivery.
          const maxReceiveCount = limit + 1;
          expect(again).toBe(attempt < maxReceiveCount && attempt - 1 < maxRedeliveries);
          // An alarm: retried while its retryCount (the attempt less one) is under both.
          const retryCount = attempt - 1;
          expect(again).toBe(retryCount < limit && retryCount < maxRedeliveries);
        }
      }
    }
  });
});
