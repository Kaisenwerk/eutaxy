/**
 * The examples double as acceptance tests: for each one the eutaxy command must find the planted bug,
 * write the regression test, and clear the fix; and each has its page on the site.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eutaxyAsync, root } from "./eutaxy-command.ts";

/**
 * What each example's check must report: the scenario file's basename (which names the regression
 * test), the scenario's name (which the report prints) and the invariant its bug breaks.
 */
interface Example {
  readonly dir: string;
  readonly scenario: string;
  readonly name: string;
  readonly invariant: string;
  readonly fixed: string;
  readonly fixedName: string;
}

const examples: readonly Example[] = [
  {
    dir: "payments-queue",
    scenario: "payments",
    name: "payments",
    invariant: "payment-recorded-once",
    fixed: "payments.fixed",
    fixedName: "payments-fixed",
  },
  {
    dir: "webhook-idempotency",
    scenario: "deposits",
    name: "deposits",
    invariant: "credited-once",
    fixed: "deposits.fixed",
    fixedName: "deposits-fixed",
  },
  {
    dir: "lease-pool",
    scenario: "leases",
    name: "leases",
    invariant: "one-runner-per-request",
    fixed: "leases.fixed",
    fixedName: "leases-fixed",
  },
  {
    dir: "agent-poll",
    scenario: "poll",
    name: "poll",
    invariant: "result-counts-every-vote",
    fixed: "poll.fixed",
    fixedName: "poll-fixed",
  },
  {
    dir: "service-binding",
    scenario: "checkout",
    name: "checkout",
    invariant: "one-charge-per-order",
    fixed: "checkout.fixed",
    fixedName: "checkout-fixed",
  },
  {
    dir: "workflow-approval",
    scenario: "expenses",
    name: "expenses",
    invariant: "paid-once",
    fixed: "expenses.fixed",
    fixedName: "expenses-fixed",
  },
];

test("every directory under examples/ is in the table", () => {
  const dirs = readdirSync(join(root, "examples"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  expect(dirs).toEqual(examples.map((e) => e.dir).sort());
});

// The checks run side by side (each is its own process, and two checks of one directory may run at
// once); the run caps below, not the wall-clock budgets, end each exploration.
describe.each(examples)("examples/$dir", (example) => {
  const cwd = join(root, "examples", example.dir);

  test.concurrent("the check finds the bug and writes the regression test", async ({ expect }) => {
    const regression = join(cwd, `${example.scenario}.regression.test.ts`);
    rmSync(regression, { force: true });
    try {
      // The run cap, not the runner's speed, ends exploration (see tests/eutaxy-command.ts): seed
      // "example" finds each bug within the first twenty runs.
      const r = await eutaxyAsync(
        [
          "check",
          `./${example.scenario}.sim.ts`,
          "--seed",
          "example",
          "--max-runs",
          "50",
          "--budget-ms",
          "60000",
        ],
        cwd,
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stdout).toContain(`VIOLATED  ${example.name}`);
      expect(r.stdout).toContain(`Invariant ${example.invariant} is violated`);
      expect(r.stdout).toContain(
        `Regression test written to ${example.scenario}.regression.test.ts`,
      );
      expect(existsSync(regression)).toBe(true);
      // It replays under the budget the check ran with.
      expect(readFileSync(regression, "utf8")).toContain("budgetMs: 60000");
    } finally {
      rmSync(regression, { force: true });
    }
  }, 180_000);

  test.concurrent("the fixed Worker is BOUNDED", async ({ expect }) => {
    const r = await eutaxyAsync(
      [
        "check",
        `./${example.fixed}.sim.ts`,
        "--seed",
        "example",
        "--max-runs",
        "30",
        "--budget-ms",
        "30000",
      ],
      cwd,
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`BOUNDED  ${example.fixedName}`);
    expect(r.stdout).toContain("This is not a proof.");
  }, 180_000);

  test("has a README and a page on the site that includes it", () => {
    expect(existsSync(join(cwd, "README.md"))).toBe(true);
    const page = join(root, "site", "examples", `${example.dir}.md`);
    expect(existsSync(page), page).toBe(true);
    expect(readFileSync(page, "utf8")).toContain(
      `<!--@include: ../../examples/${example.dir}/README.md-->`,
    );
    const config = readFileSync(join(root, "site", ".vitepress", "config.ts"), "utf8");
    // The sidebar and the page dates come from the config's list of examples.
    expect(config).toContain(`{ dir: "${example.dir}", text: "`);
  });
});
