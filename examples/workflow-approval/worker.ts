/**
 * Expense approval as a Cloudflare Workflow. Submitting an expense starts an
 * instance, which waits up to a week for the manager's decision, delivered
 * later as an event; once approved, a step pays the employee through a
 * payouts API. The payout is a step, so the Workflow does not repeat it
 * after a restart. Run `eutaxy check ./expenses.sim.ts` to see that a step
 * is not enough.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface Env {
  readonly APPROVALS: Workflow<Expense>;
}

export interface Expense {
  readonly expenseId: string;
  readonly employee: string;
  readonly amountCents: number;
}

export interface Decision {
  readonly approved: boolean;
  readonly by: string;
}

/** Pays the expense out; `headers` lets a caller add its own (the fix adds an idempotency key). */
export async function payOut(
  expense: Expense,
  headers: Record<string, string> = {},
): Promise<{ payoutId: string }> {
  const res = await fetch("https://payouts.example/payouts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(expense),
  });
  if (!res.ok) throw new Error(`payout failed with ${res.status}`);
  return (await res.json()) as { payoutId: string };
}

export class ExpenseApproval extends WorkflowEntrypoint<Env, Expense> {
  override async run(event: WorkflowEvent<Expense>, step: WorkflowStep) {
    const expense = event.payload;
    const decision = await step.waitForEvent<Decision>("manager decision", {
      type: "decision",
      timeout: "7 days",
    });
    if (!decision.payload.approved) return { expenseId: expense.expenseId, paid: false };
    const payout = await step.do("pay out", () => this.pay(expense));
    return { expenseId: expense.expenseId, paid: true, payoutId: payout.payoutId };
  }

  protected pay(expense: Expense): Promise<{ payoutId: string }> {
    return payOut(expense);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/expenses") {
      const expense = (await request.json()) as Expense;
      await env.APPROVALS.create({ id: expense.expenseId, params: expense });
      return Response.json({ submitted: expense.expenseId }, { status: 202 });
    }
    const decided = /^\/expenses\/([\w-]+)\/decision$/.exec(url.pathname);
    if (request.method === "POST" && decided?.[1]) {
      const decision = (await request.json()) as Decision;
      const instance = await env.APPROVALS.get(decided[1]);
      await instance.sendEvent({ type: "decision", payload: decision });
      return Response.json({ decided: decided[1] });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
