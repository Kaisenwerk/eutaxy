import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  type HttpRequestInput,
  http,
  objectCall,
} from "@eutaxy/cloudflare";

const scenario = (name: string, requests: readonly HttpRequestInput[]) =>
  defineScenario({
    name,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("COUNTER")],
    drive: http(requests, { retries: 0 }),
    externals: [],
    invariants: [atMostOncePerKey("quit-once", objectCall("COUNTER", "quit"), "args.object")],
    bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
  });

/** The object counts, resets itself, and is called again within one request. */
export const calledAgain = scenario("object-resets-itself-called-again", [
  { id: "r-1", path: "/quit-then-count", method: "POST" },
]);

/** The object counts, resets itself in a second request, and a third request calls it through a stub of its own. */
export const calledLater = scenario("object-resets-itself-called-later", [
  { id: "r-1", path: "/count", method: "POST" },
  { id: "r-2", path: "/quit", method: "POST" },
  { id: "r-3", path: "/count", method: "POST" },
]);

/** The object answers and resets itself afterwards, so no call fails; a later request calls it. */
export const quitsAfterAnswering = scenario("object-resets-itself-after-answering", [
  { id: "r-1", path: "/count", method: "POST" },
  { id: "r-2", path: "/quit-later", method: "POST" },
  { id: "r-3", path: "/count", method: "POST" },
]);

/** The object resets itself in two requests, and a third calls it. */
export const quitsTwice = scenario("object-resets-itself-twice", [
  { id: "r-1", path: "/quit", method: "POST" },
  { id: "r-2", path: "/quit", method: "POST" },
  { id: "r-3", path: "/count", method: "POST" },
]);

/** A call into the object fails in the ordinary way, and a later request calls it: the same instance. */
export const refusedThenCalled = scenario("object-refuses-and-is-called-later", [
  { id: "r-1", path: "/count", method: "POST" },
  { id: "r-2", path: "/refuse", method: "POST" },
  { id: "r-3", path: "/count", method: "POST" },
]);

/** The object resets itself and nothing calls it again. */
export const leftAlone = scenario("object-resets-itself-left-alone", [
  { id: "r-1", path: "/count", method: "POST" },
  { id: "r-2", path: "/quit", method: "POST" },
]);

export default calledLater;
