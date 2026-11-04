/**
 * The inventory Worker, called over a service binding by RPC. `reserve` is
 * idempotent per reservation id, as its contract promises: a resend with the
 * same id finds the reservation it made and answers it again. Nothing here is
 * wrong on its own.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
}

export default class Inventory extends WorkerEntrypoint<Env> {
  async reserve(
    reservationId: string,
    orderId: string,
    sku: string,
    qty: number,
  ): Promise<{ reservationId: string }> {
    const existing = await this.env.DB.prepare(
      "SELECT reservation_id FROM reservations WHERE reservation_id = ?1",
    )
      .bind(reservationId)
      .first();
    if (existing) return { reservationId };
    await this.env.DB.prepare(
      "INSERT INTO reservations (reservation_id, order_id, sku, qty) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(reservationId, orderId, sku, qty)
      .run();
    return { reservationId };
  }
}
