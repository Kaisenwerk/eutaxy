/**
 * The AWS platform held to the delivery model core proves (`deliveries`):
 * an SQS message is delivered exactly as often as the model says, attempt
 * by attempt, to a handler called once per delivery, on every list of
 * outcomes, every maxReceiveCount (the model's limit and one more, as it
 * counts the first delivery) and every bound of the scenario's up to a
 * bound. A delivery is made not handled in these ways: the handler
 * throws, reports the message as a batch item failure, or an injected
 * crash loses the message's deletion. Exhaustive within the bounds, not
 * sampled. The
 * platform delivers one event at a time, so no run has two in flight.
 */
import {
  atMostOncePerKey,
  deliveries,
  type FaultDecision,
  invocationOf,
  type Platform,
} from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createAwsPlatform, type SqsHandler } from "./platform.ts";
import { defineAwsScenario, sqs, sqsDelete } from "./scenario.ts";

/** How a message that was not handled stays on the queue: by what the handler does, or by a crash injected at an attempt. */
const ways: {
  readonly name: string;
  handler(handled: () => boolean): SqsHandler;
  readonly crash?: (attempt: number) => FaultDecision;
}[] = [
  {
    name: "a message a return deletes and a throw leaves",
    handler: (handled) => async () => {
      if (!handled()) throw new Error("not handled");
      return undefined;
    },
  },
  {
    name: "a message a return deletes and a reported batch item failure leaves",
    handler: (handled) => async (event) =>
      handled()
        ? undefined
        : { batchItemFailures: [{ itemIdentifier: event.Records[0]?.messageId ?? "" }] },
  },
  {
    name: "a message whose deletion a crash loses",
    handler: (handled) => async () => {
      handled();
      return undefined;
    },
    // The handler makes no SDK call, so the deletion is the invocation's first effect.
    crash: (attempt) => ({
      invocation: `msg-1#${attempt}`,
      ordinal: 0,
      fault: "crash_before",
      target: "SQS:q",
      op: "delete",
    }),
  },
];

describe("the AWS platform refines the proved delivery model", () => {
  // Six outcomes under limits up to four: every limit is passed by a list that goes on beyond it.
  const lists = Array.from({ length: 2 ** 6 }, (_, bits) =>
    Array.from({ length: 6 }, (_, i) => ((bits >> i) & 1) === 1),
  );
  const limits = [0, 1, 2, 3, 4];

  test.each(ways)(
    "$name: every list of six outcomes under every limit and bound up to four",
    async (way) => {
      for (const handled of lists)
        for (const limit of limits)
          for (const maxRedeliveries of limits) {
            /** How often the handler was called: once per delivery. */
            let asked = 0;
            // Past the list's end the model says no delivery is made; one made anyway is counted and fails.
            const inner = createAwsPlatform({
              handler: way.handler(() => handled[asked++] ?? false),
              clients: {},
            });
            /** Every delivery the run loop made, in the order it made them. */
            const delivered: string[] = [];
            const platform: Platform = {
              ...inner,
              deliver(event, hooks, spec) {
                delivered.push(invocationOf(event));
                return inner.deliver(event, hooks, spec);
              },
            };
            const spec = defineAwsScenario({
              name: "delivery-model",
              handler: { entry: "./handler.ts", config: "template.yaml" },
              drive: sqs("q", [{ body: null }], { maxReceiveCount: limit + 1 }),
              // A scenario states one; the runs here are counted, not checked against it.
              invariants: [atMostOncePerKey("deleted-once", sqsDelete("q"), "args.messageId")],
              bounds: {
                maxFaultsPerRun: 0,
                maxRedeliveries,
                maxConcurrentInvocations: 1,
                budgetMs: 10_000,
              },
            });
            const { crash } = way;
            const faults =
              crash === undefined ? [] : handled.flatMap((h, i) => (h ? [] : [crash(i + 1)]));
            // A replayed schedule takes the faults it lists, however many: the bound is the chooser's.
            const run = new Run({
              bounds: spec.bounds,
              chooser: replayChooser({ seed: 1, faults }),
            });
            await runOnce(spec, platform, run);
            const told = `outcomes ${JSON.stringify(handled)}, maxReceiveCount ${limit + 1}, bound ${maxRedeliveries}`;
            expect(run.unsupportedReasons, told).toEqual([]);
            const count = deliveries(handled, limit, maxRedeliveries);
            expect(delivered, told).toEqual(
              Array.from({ length: count }, (_, i) => `msg-1#${i + 1}`),
            );
            expect(asked, told).toBe(count);
          }
    },
  );
});
