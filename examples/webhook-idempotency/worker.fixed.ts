/**
 * The same webhook, made safe to resend: the credit itself is keyed by the
 * event id, so the check and the write are one statement and a resend
 * changes nothing. `eutaxy check ./deposits.fixed.sim.ts` reports BOUNDED.
 */

import type { DepositEvent, Env } from "./worker.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhooks/deposits") {
      return new Response("not found", { status: 404 });
    }
    const event = (await request.json()) as DepositEvent;
    const { meta } = await env.DB.prepare(
      "INSERT INTO ledger (event_id, account, amount_cents) VALUES (?1, ?2, ?3) ON CONFLICT (event_id) DO NOTHING",
    )
      .bind(event.id, event.account, event.amountCents)
      .run();
    return Response.json(meta.changes === 0 ? { duplicate: event.id } : { credited: event.id });
  },
} satisfies ExportedHandler<Env>;
