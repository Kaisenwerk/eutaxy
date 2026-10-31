/**
 * An orders consumer: for each order message it charges the customer through
 * the billing Worker (a service binding, RPC) and records the order as paid.
 *
 * Planted bug: the charge is not idempotent on the order. When the billing
 * call's answer is lost (the callee charged, the caller saw an error), the
 * handler fails, Queues redeliver the message, and the redelivery charges
 * the same order again.
 */

export interface Env {
  readonly DB: D1Database;
  readonly BILLING: Fetcher & Billing;
}

/** The billing Worker's entrypoint, as this Worker calls it. */
export interface Billing {
  charge(orderId: string, amountCents: number): Promise<{ chargeId: string }>;
}

export interface OrderMessage {
  readonly orderId: string;
  readonly amountCents: number;
}

export default {
  async queue(batch: MessageBatch<OrderMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, amountCents } = message.body;
      const { chargeId } = await env.BILLING.charge(orderId, amountCents);
      await env.DB.prepare("INSERT INTO orders (order_id, charge_id) VALUES (?1, ?2)")
        .bind(orderId, chargeId)
        .run();
    }
  },
} satisfies ExportedHandler<Env, OrderMessage>;
