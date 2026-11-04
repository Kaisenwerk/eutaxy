/**
 * A storefront's orders consumer: for each order it reserves stock through
 * the inventory Worker (a service binding, RPC) and records the order with
 * its reservation.
 *
 * Planted bug: the idempotency key the inventory Worker honours is drawn
 * per attempt. When the reserve call's answer is lost (the callee reserved,
 * the caller saw an error), the handler fails, Queues redeliver the message,
 * and the redelivery reserves again under a new key: the inventory Worker,
 * idempotent per key as it promises, now holds two reservations for one
 * order. Each Worker is right by its own contract; the system is wrong.
 */

export interface Env {
  readonly DB: D1Database;
  readonly INVENTORY: Fetcher & Inventory;
}

/** The inventory Worker's entrypoint, as this Worker calls it. */
export interface Inventory {
  reserve(
    reservationId: string,
    orderId: string,
    sku: string,
    qty: number,
  ): Promise<{ reservationId: string }>;
}

export interface OrderMessage {
  readonly orderId: string;
  readonly sku: string;
  readonly qty: number;
}

export default {
  async queue(batch: MessageBatch<OrderMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, sku, qty } = message.body;
      const reservationId = crypto.randomUUID();
      const reserved = await env.INVENTORY.reserve(reservationId, orderId, sku, qty);
      await env.DB.prepare("INSERT INTO orders (order_id, reservation_id) VALUES (?1, ?2)")
        .bind(orderId, reserved.reservationId)
        .run();
    }
  },
} satisfies ExportedHandler<Env, OrderMessage>;
