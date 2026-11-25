import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  http,
  objectCall,
} from "@eutaxy/cloudflare";

/** The retries the runtime gives a failed alarm. */
export const retries = 6;

/** Every list of eight outcomes, two more than the retries, each under the name of its object. */
export const lists = Array.from({ length: 2 ** 8 }, (_, bits) => ({
  object: `o${bits}`,
  handled: Array.from({ length: 8 }, (_, i) => ((bits >> i) & 1) === 1),
}));

/** One request per object arms its alarm with its outcomes; no faults, and this bound on redeliveries. */
export const armed = (maxRedeliveries: number) =>
  defineScenario({
    name: `alarm-deliveries-${maxRedeliveries}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("REMINDER", Object.fromEntries(lists.map((l) => [l.object, {}])))],
    drive: http(
      lists.map((l) => ({ path: `/${l.object}`, body: l.handled })),
      { retries: 0 },
    ),
    externals: [],
    invariants: [atMostOncePerKey("armed-once", objectCall("REMINDER", "arm"), "args.object")],
    bounds: {
      maxFaultsPerRun: 0,
      maxRedeliveries,
      maxConcurrentInvocations: 1,
      budgetMs: 60_000,
    },
  });

/** Under the runtime's own six retries and no lower bound. */
export default armed(retries);
