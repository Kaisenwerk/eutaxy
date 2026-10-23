/**
 * A payments queue consumer that gives each row a fresh random id and relies
 * on INSERT OR IGNORE to make retries harmless.
 *
 * Planted bug: the only uniqueness is on the random id, so a redelivered
 * message inserts a second row for the same order. The developer believed
 * "OR IGNORE" made the write idempotent; it only ignores collisions on `id`,
 * which never collide.
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
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO payments (id, order_id, amount_cents, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(id, orderId, amountCents, Date.now())
        .run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Payment>;
