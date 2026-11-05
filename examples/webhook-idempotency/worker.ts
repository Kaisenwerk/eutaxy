/**
 * A payment provider's deposit webhook. Each event credits an account in a
 * D1 ledger. The provider resends any event it got no 2xx for, so the
 * handler keeps the ids of the events it has processed and skips a resend
 * it has seen. Run `eutaxy check ./deposits.sim.ts` to see why that is not
 * enough.
 */

export interface Env {
  readonly DB: D1Database;
}

/** The event the provider posts; `id` is the provider's idempotency key, the same on every resend. */
export interface DepositEvent {
  readonly id: string;
  readonly account: string;
  readonly amountCents: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhooks/deposits") {
      return new Response("not found", { status: 404 });
    }
    const event = (await request.json()) as DepositEvent;
    const seen = await env.DB.prepare("SELECT event_id FROM processed_events WHERE event_id = ?1")
      .bind(event.id)
      .first();
    if (seen) return Response.json({ duplicate: event.id });
    await env.DB.prepare("INSERT INTO ledger (event_id, account, amount_cents) VALUES (?1, ?2, ?3)")
      .bind(event.id, event.account, event.amountCents)
      .run();
    await env.DB.prepare("INSERT INTO processed_events (event_id) VALUES (?1)")
      .bind(event.id)
      .run();
    return Response.json({ credited: event.id });
  },
} satisfies ExportedHandler<Env>;
