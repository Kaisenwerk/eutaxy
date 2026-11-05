/**
 * A checkout Worker that charges an order through the payments Worker,
 * reached over a service binding by RPC. The payments Worker is idempotent
 * per key, so the checkout sends a fresh key with each charge. Clients
 * resend a payment request that got no answer. Run `eutaxy check
 * ./checkout.sim.ts` to see both Workers run together, and what the key
 * protects against and what it does not.
 */

import type { Payments } from "./payments/worker.ts";

export interface Env {
  readonly PAYMENTS: Service<Payments>;
}

/** The key the payments Worker deduplicates by; the planted checkout draws one per request. */
export function chargeKey(_orderId: string): string {
  return crypto.randomUUID();
}

export function checkout(key: (orderId: string) => string): ExportedHandler<Env> {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const match = /^\/orders\/([\w-]+)\/pay$/.exec(new URL(request.url).pathname);
      if (request.method !== "POST" || !match?.[1]) {
        return new Response("not found", { status: 404 });
      }
      const orderId = match[1];
      const { amountCents } = (await request.json()) as { amountCents: number };
      const charge = await env.PAYMENTS.charge(key(orderId), orderId, amountCents);
      return Response.json({ orderId, chargeId: charge.chargeId });
    },
  };
}

export default checkout(chargeKey);
