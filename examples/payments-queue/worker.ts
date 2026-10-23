/**
 * A queue consumer that records each payment in D1 and acknowledges the
 * message. It looks fine and passes ordinary tests. Run `eutaxy check
 * ./payments.sim.ts` to see what happens when the invocation dies between
 * the insert and the acknowledgement.
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
