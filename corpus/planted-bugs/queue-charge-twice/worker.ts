/**
 * A payments queue consumer that charges the customer through an external
 * payments API and then acknowledges the message.
 *
 * Planted bug: the request carries no idempotency key. If the invocation
 * dies after the charge went through but before ack() (or the API's reply
 * is lost on the way back), the message is redelivered and the customer is
 * charged a second time.
 */

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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, amountCents }),
      });
      if (!res.ok) throw new Error(`charge failed with ${res.status}`);
      message.ack();
    }
  },
} satisfies ExportedHandler<unknown, Payment>;
