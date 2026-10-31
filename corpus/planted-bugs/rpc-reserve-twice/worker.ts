/**
 * An inventory service other Workers call over RPC: `reserve(orderId, qty)`
 * records the reservation in D1 and answers with it.
 *
 * Planted bug: the method is not idempotent. Cloudflare does not retry an RPC
 * call, but the calling Worker does when it gets an error or no answer, so a
 * crash between the insert and the answer makes the resend reserve the same
 * order a second time.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
}

export default class Inventory extends WorkerEntrypoint<Env> {
  async reserve(orderId: string, qty: number): Promise<{ orderId: string; qty: number }> {
    await this.env.DB.prepare("INSERT INTO reservations (order_id, qty) VALUES (?1, ?2)")
      .bind(orderId, qty)
      .run();
    return { orderId, qty };
  }
}
