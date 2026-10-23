/** The queue-charge-twice consumer, fixed: every charge carries an Idempotency-Key. */

export interface Payment {
  readonly orderId: string;
  readonly amountCents: number;
}

export default {
  async queue(batch: MessageBatch<Payment>): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, amountCents } = message.body;
      const res = await fetch("https://api.payments.example/charges", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": orderId },
        body: JSON.stringify({ orderId, amountCents }),
      });
      if (!res.ok) throw new Error(`charge failed with ${res.status}`);
      message.ack();
    }
  },
} satisfies ExportedHandler<unknown, Payment>;
