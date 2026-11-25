import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  http,
  objectCall,
} from "@eutaxy/cloudflare";

/** Every list of exactly `length` changes: true sets the alarm again, false deletes it. */
function changeLists(length: number): boolean[][] {
  if (length === 0) return [[]];
  return changeLists(length - 1).flatMap((changes) => [
    [...changes, true],
    [...changes, false],
  ]);
}

/** Every list of up to four changes, each under the name of its object. */
export const lists = [0, 1, 2, 3, 4]
  .flatMap(changeLists)
  .map((changes, i) => ({ object: `o${i}`, changes }));

/** The object whose alarm always fails. */
export const failing = "failing";

/** One request per object arms it as `armed` says; no faults. */
const scenario = (
  name: string,
  armed: readonly { object: string; changes: readonly boolean[]; fails: boolean }[],
) =>
  defineScenario({
    name,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("REMINDER", Object.fromEntries(armed.map((a) => [a.object, {}])))],
    drive: http(
      armed.map((a) => ({ path: `/${a.object}`, body: { changes: a.changes, fails: a.fails } })),
      { retries: 0 },
    ),
    externals: [],
    invariants: [atMostOncePerKey("armed-once", objectCall("REMINDER", "arm"), "args.object")],
    bounds: {
      maxFaultsPerRun: 0,
      maxRedeliveries: 6,
      maxConcurrentInvocations: 1,
      budgetMs: 60_000,
    },
  });

/** One object for every list of changes, its handler succeeding. */
export const changed = scenario(
  "alarm-rules-changed",
  lists.map((l) => ({ ...l, fails: false })),
);

/** One object whose alarm, never changed, fails on every run. */
export const retried = scenario("alarm-rules-retried", [
  { object: failing, changes: [], fails: true },
]);

export default changed;
