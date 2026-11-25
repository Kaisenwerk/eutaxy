/**
 * Runs inside workerd: a Durable Object's alarm held to the delivery model
 * core proves (`deliveries`). The alarms of real objects, each told whether
 * its deliveries in turn are handled, are delivered exactly as often as the
 * model says under the runtime's six retries, attempt by attempt, and the
 * handler runs once per delivery: one object for every list of eight
 * outcomes (so the six retries are passed by lists that go on beyond
 * them), their retries interleaved by their backoff, under every bound of
 * the scenario's up to seven. Exhaustive within the bounds, not sampled.
 * An alarm here fails by its handler throwing and none is set again, so
 * none is superseded.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createCloudflarePlatform } from "@eutaxy/cloudflare";
import { deliveries, type Platform } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { expect, test } from "vitest";
import { armed, lists, retries } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

test.each([0, 1, 2, 3, 4, 5, 6, 7])(
  "every alarm is delivered as often as the model says: every list of eight outcomes under a bound of %i",
  async (maxRedeliveries) => {
    const inner = createCloudflarePlatform({
      env,
      handler: worker.default,
      schemas: {},
      exports: worker,
      durableObjects: cloudflareTest,
    });
    /** The attempts of every alarm delivery the run loop made, per object, in the order it made them. */
    const delivered = new Map<string, number[]>();
    const platform: Platform = {
      ...inner,
      deliver(event, hooks, spec) {
        const alarm = /^alarm:REMINDER:(o\d+):/.exec(event.id);
        if (alarm?.[1] !== undefined)
          delivered.set(alarm[1], [...(delivered.get(alarm[1]) ?? []), event.attempt]);
        return inner.deliver(event, hooks, spec);
      },
    };
    const spec = armed(maxRedeliveries);
    const reminders = (env as unknown as worker.Env).REMINDER;
    worker.ran.clear();
    const run = new Run({ bounds: spec.bounds, chooser: replayChooser({ seed: 1, faults: [] }) });
    await runOnce(spec, platform, run);
    expect(run.unsupportedReasons).toEqual([]);
    for (const { object, handled } of lists) {
      const count = deliveries(handled, retries, maxRedeliveries);
      const told = `outcomes ${JSON.stringify(handled)}`;
      expect(delivered.get(object), told).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      // The handler ran once per delivery, each time told the retries before it.
      expect(worker.ran.get(reminders.idFromName(object).toString()), told).toEqual(
        Array.from({ length: count }, (_, i) => i),
      );
    }
  },
);
