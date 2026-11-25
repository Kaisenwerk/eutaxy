/**
 * An orders queue consumer: it records each order once, and tells an audit
 * service when a message comes again for an order it already recorded. The
 * scenario does not declare the audit service, so a run that gets there (a
 * redelivery after the insert committed) meets a host outside the model.
 */

export interface Env {
  readonly DB: D1Database;
}

export default {
  async queue(batch: MessageBatch<{ orderId: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId } = message.body;
      const seen = await env.DB.prepare("SELECT order_id FROM orders WHERE order_id = ?1")
        .bind(orderId)
        .first();
      if (seen) await fetch("https://audit.example/again", { method: "POST" });
      else await env.DB.prepare("INSERT INTO orders (order_id) VALUES (?1)").bind(orderId).run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, { orderId: string }>;
