/**
 * The delivery conventions: the invocation name, which pending event goes next, and the one redelivery rule held to the
 * four forms the platforms wrote before it existed, over every small combination of attempt and limits, and to the
 * delivery model, whose claims are proved, over every run of outcomes up to a bound.
 */
import { describe, expect, test } from "vitest";
import { earliestEvent, invocationOf, redelivery } from "./delivery.ts";
import { deliveries } from "./delivery-model.ts";
import type { EventRef } from "./platform.ts";

const event = (attempt: number): EventRef => ({
  id: "m1",
  attempt,
  data: { orderId: "o-1" },
  at: 5_000,
  source: "test",
});

describe("invocationOf", () => {
  test("names the attempt by its event and attempt number", () => {
    expect(invocationOf(event(1))).toBe("m1#1");
    expect(invocationOf(event(3))).toBe("m1#3");
  });
});

describe("earliestEvent", () => {
  const at = (id: string, when?: number): EventRef => ({
    id,
    attempt: 1,
    data: null,
    ...(when === undefined ? {} : { at: when }),
  });

  test("picks the earliest due event, the first queued among equals, and an undated one as due now", () => {
    expect(earliestEvent([at("a", 5), at("b", 3), at("c", 3)])).toBe(1);
    expect(earliestEvent([at("a", 5), at("b")])).toBe(1);
    expect(earliestEvent([at("a"), at("b")])).toBe(0);
    expect(earliestEvent([at("a", 7)])).toBe(0);
  });
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

  // The delivery model's claims are about limits that are whole and not negative; the rule takes no other.
  test.each([0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a platform's limit or a scenario's bound of %s",
    (bad) => {
      expect(() => redelivery(event(1), bad, { maxRedeliveries: 3 })).toThrow(
        `the platform's limit on redeliveries must be a non-negative integer, got ${bad}`,
      );
      expect(() => redelivery(event(1), 3, { maxRedeliveries: bad })).toThrow(
        `bounds.maxRedeliveries must be a non-negative integer, got ${bad}`,
      );
    },
  );

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

describe("the delivery model", () => {
  test("redelivery delivers an event exactly as often as the model says, on every case up to a bound", () => {
    // Every list of outcomes of up to six deliveries, under every limit and bound up to four, so each
    // limit is passed by a list that goes on beyond it.
    for (let length = 0; length <= 6; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        const handled = Array.from({ length }, (_, i) => ((bits >> i) & 1) === 1);
        for (let limit = 0; limit <= 4; limit++) {
          for (let maxRedeliveries = 0; maxRedeliveries <= 4; maxRedeliveries++) {
            // Delivered as a platform delivers: an attempt per outcome, the next one redelivery's while not handled.
            let delivered = 0;
            let next: EventRef | null = event(1);
            for (const wasHandled of handled) {
              if (next === null) break;
              delivered++;
              expect(next.attempt).toBe(delivered);
              next = wasHandled ? null : redelivery(next, limit, { maxRedeliveries });
            }
            expect(delivered).toBe(deliveries(handled, limit, maxRedeliveries));
            // And as often as the count written out here, which shares no code with the rule: a
            // mistake in `redelivers` moves the loop and the model together.
            const firstHandled = handled.indexOf(true);
            expect(delivered).toBe(
              Math.min(
                length,
                (firstHandled < 0 ? length : firstHandled) + 1,
                limit + 1,
                maxRedeliveries + 1,
              ),
            );
          }
        }
      }
    }
  });
});
