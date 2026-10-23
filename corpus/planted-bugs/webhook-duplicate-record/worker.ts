/**
 * A payment-provider webhook: records each provider event in D1 and answers 200.
 *
 * Planted bug: the handler is not idempotent. Providers resend a webhook they
 * got no 2xx for, so a crash between the insert and the response (or right
 * after the insert) makes the resend insert the same event a second time.
 */

export interface Env {
  readonly DB: D1Database;
}

export interface ProviderEvent {
  readonly eventId: string;
  readonly orderId: string;
  readonly amountCents: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhooks/payments") {
      return new Response("not found", { status: 404 });
    }
    const event = (await request.json()) as ProviderEvent;
    await env.DB.prepare(
      "INSERT INTO payment_events (event_id, order_id, amount_cents) VALUES (?1, ?2, ?3)",
    )
      .bind(event.eventId, event.orderId, event.amountCents)
      .run();
    return Response.json({ recorded: event.eventId });
  },
} satisfies ExportedHandler<Env>;
