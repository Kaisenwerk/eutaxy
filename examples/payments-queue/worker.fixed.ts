/**
 * The same consumer, made safe to redeliver: the insert is idempotent on
 * the order id, so a retried message changes nothing. `eutaxy check
 * ./payments.fixed.sim.ts` reports BOUNDED.
 */

import type { Env, Payment } from "./worker.ts";

export default {
  async queue(batch: MessageBatch<Payment>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, amountCents } = message.body;
      await env.DB.prepare(
        "INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2) ON CONFLICT (order_id) DO NOTHING",
      )
        .bind(orderId, amountCents)
        .run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Payment>;
