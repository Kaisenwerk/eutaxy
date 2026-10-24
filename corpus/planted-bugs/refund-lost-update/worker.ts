/**
 * A refund endpoint: read the order, let the core decide, write the new
 * refunded total.
 *
 * Planted bug: a lost update. The write sets the total the core computed
 * from the read, so two refunds in flight at once both decide on the same
 * read and the second write overwrites the first: the order shows one
 * refund while two were granted. Each decision is right on the state it
 * saw; `refines` reports that the state had changed by the time the write
 * committed. The fix (`fixed`) writes only if the total is still the one
 * read, and asks the caller to retry otherwise.
 */

import { decideRefund } from "./domain.ts";

export interface Env {
  readonly DB: D1Database;
}

interface Order {
  readonly captured_cents: number;
  readonly refunded_cents: number;
}

async function refund(
  request: Request,
  env: Env,
  write: (orderId: string, refunded: number, read: number) => Promise<boolean>,
): Promise<Response> {
  const { orderId, amountCents } = (await request.json()) as {
    orderId: string;
    amountCents: number;
  };
  const order = await env.DB.prepare(
    "SELECT captured_cents, refunded_cents FROM orders WHERE id = ?1",
  )
    .bind(orderId)
    .first<Order>();
  if (!order) return new Response("no such order", { status: 404 });
  const decision = decideRefund(order.captured_cents, order.refunded_cents, amountCents);
  if (!decision.ok) return Response.json({ refunded: false }, { status: 409 });
  if (!(await write(orderId, decision.refunded, order.refunded_cents)))
    return Response.json({ refunded: false, retry: true }, { status: 409 });
  return Response.json({ refunded: true, total: decision.refunded });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return refund(request, env, async (orderId, refunded) => {
      await env.DB.prepare("UPDATE orders SET refunded_cents = ?2 WHERE id = ?1")
        .bind(orderId, refunded)
        .run();
      return true;
    });
  },
} satisfies ExportedHandler<Env>;

/** The fix: compare and set, so a write on a stale read changes nothing. */
export const fixed = {
  fetch(request: Request, env: Env): Promise<Response> {
    return refund(request, env, async (orderId, refunded, read) => {
      const r = await env.DB.prepare(
        "UPDATE orders SET refunded_cents = ?2 WHERE id = ?1 AND refunded_cents = ?3",
      )
        .bind(orderId, refunded, read)
        .run();
      return (r.meta.changes ?? 0) > 0;
    });
  },
} satisfies ExportedHandler<Env>;
