/**
 * A payments queue consumer. For each message it records the payment in D1
 * and then acknowledges the message.
 *
 * Planted bug: the insert is not idempotent and the table has no uniqueness
 * on order_id. If the invocation dies after the insert commits but before
 * ack() is called, the queue redelivers the message and the payment is
 * recorded twice.
 */

export interface Env {
  readonly DB: D1Database;
}

export interface Payment {
  readonly orderId: string;
  readonly amountCents: number;
}

export default {
  async queue(batch: MessageBatch<Payment>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, amountCents } = message.body;
      await env.DB.prepare("INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2)")
        .bind(orderId, amountCents)
        .run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Payment>;
