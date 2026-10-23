import {
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  http,
} from "eutaxy/cloudflare";

// The same address asks twice in the same second, as a double click or a second tab does.
// A browser does not resend, so the caller never retries.
const requests = http(
  [
    { path: "/sign-in/code", body: { email: "ada@example.com" } },
    { path: "/sign-in/code", body: { email: "ada@example.com" } },
  ],
  { retries: 0 },
);

export default defineScenario({
  name: "signin-code-rate-limit",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: requests,
  invariants: [
    // The bug: both requests read "no recent code" before either inserts, so both send one.
    atMostOncePerKey("one-code-per-window", d1Write("DB"), d1Param(0)),
  ],
  // No faults are needed: the interleaving alone breaks the limit.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
