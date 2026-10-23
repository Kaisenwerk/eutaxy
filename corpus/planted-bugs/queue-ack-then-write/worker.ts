/**
 * A payments queue consumer that acknowledges first "for throughput" and
 * records the payment in background work via ctx.waitUntil.
 *
 * Planted bug: once the message is acknowledged it will never be redelivered,
 * so if the isolate is cut off before the background insert runs, the payment
 * is lost for good. The lookup before the insert is the await that lets the
 * cut-off land between "acknowledged" and "written".
 */

export interface Env {
  readonly DB: D1Database;
}

export interface Payment {
  readonly orderId: string;
  readonly amountCents: number;
}

async function record(env: Env, payment: Payment): Promise<void> {
  const existing = await env.DB.prepare("SELECT 1 AS one FROM payments WHERE order_id = ?1")
    .bind(payment.orderId)
    .first<{ one: number }>();
  if (existing === null) {
    await env.DB.prepare("INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2)")
      .bind(payment.orderId, payment.amountCents)
      .run();
  }
}

export default {
  async queue(batch: MessageBatch<Payment>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      message.ack();
      ctx.waitUntil(record(env, message.body));
    }
  },
} satisfies ExportedHandler<Env, Payment>;
