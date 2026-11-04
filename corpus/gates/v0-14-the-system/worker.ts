/**
 * The storefront, a Worker of a system split by business context: its orders
 * consumer reserves stock through the inventory Worker (a service binding,
 * RPC) under a key derived from the order, so a resend after a lost answer
 * finds the same reservation; reads the stock left from the inventory's
 * stock object directly (the namespace is shared); records the order; and
 * asks the inventory Worker to start fulfilment. Nothing here is wrong on
 * purpose: the v0.14 gate asks that both Workers' real code run with no
 * UNSUPPORTED verdict and every invariant hold.
 */

export interface Env {
  readonly DB: D1Database;
  readonly INVENTORY: Fetcher & Inventory;
  readonly STOCK: DurableObjectNamespace;
}

/** The inventory Worker's entrypoint, as this Worker calls it. */
export interface Inventory {
  reserve(
    reservationId: string,
    orderId: string,
    sku: string,
    qty: number,
  ): Promise<{ reservationId: string; available: number }>;
  fulfil(orderId: string): Promise<{ started: boolean }>;
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
      const reservationId = `res-${orderId}`;
      await env.INVENTORY.reserve(reservationId, orderId, sku, qty);
      // The stock object of the sku, read directly: how much is left after this reservation.
      const stock = env.STOCK.get(env.STOCK.idFromName(sku)) as unknown as {
        available(): Promise<number>;
      };
      const available = await stock.available();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO orders (order_id, reservation_id, available_after) VALUES (?1, ?2, ?3)",
      )
        .bind(orderId, reservationId, available)
        .run();
      await env.INVENTORY.fulfil(orderId);
    }
  },
} satisfies ExportedHandler<Env, OrderMessage>;
