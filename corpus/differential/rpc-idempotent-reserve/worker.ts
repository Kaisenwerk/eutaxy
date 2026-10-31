/**
 * A correct inventory service called over RPC: `reserve(orderId, qty)` is
 * idempotent on the order id (`INSERT OR IGNORE` under a unique index) and
 * answers whether this call made the reservation, so a caller's resend after
 * a lost answer reserves nothing twice; `reservation(orderId)` reads it back.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
}

export default class Inventory extends WorkerEntrypoint<Env> {
  async reserve(orderId: string, qty: number): Promise<{ orderId: string; reserved: boolean }> {
    if (qty <= 0) throw new RangeError(`qty must be positive, got ${qty}`);
    const result = await this.env.DB.prepare(
      "INSERT OR IGNORE INTO reservations (order_id, qty) VALUES (?1, ?2)",
    )
      .bind(orderId, qty)
      .run();
    return { orderId, reserved: result.meta.changes === 1 };
  }

  async reservation(orderId: string): Promise<{ orderId: string; qty: number } | null> {
    const row = await this.env.DB.prepare("SELECT qty FROM reservations WHERE order_id = ?1")
      .bind(orderId)
      .first<{ qty: number }>();
    return row === null ? null : { orderId, qty: row.qty };
  }
}
