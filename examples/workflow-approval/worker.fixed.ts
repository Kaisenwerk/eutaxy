/**
 * The same Workflow, made safe to retry: the payout carries the expense id
 * as its idempotency key, which the payouts API deduplicates by, so a step
 * that runs again pays nothing more. `eutaxy check ./expenses.fixed.sim.ts`
 * reports BOUNDED.
 */

import { type Expense, ExpenseApproval as PlantedApproval, payOut } from "./worker.ts";

export { default } from "./worker.ts";

export class ExpenseApproval extends PlantedApproval {
  protected override pay(expense: Expense): Promise<{ payoutId: string }> {
    return payOut(expense, { "idempotency-key": `expense:${expense.expenseId}` });
  }
}
