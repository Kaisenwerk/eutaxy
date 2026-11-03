/**
 * A store's inventory in a Durable Object on SQLite storage: a reservation
 * checks the stock of a SKU, holds it with the warehouse through an
 * external API, then decrements the row.
 *
 * Planted bug: the check and the decrement are separated by the warehouse
 * call. The input gate holds other events only during storage operations,
 * not during outbound fetch, so a second reservation runs while the first
 * awaits the warehouse: both see one unit, both hold it, and the stock goes
 * to -1. The fix decrements first, in one statement guarded by the stock
 * (`qty >= ?`), and holds with the warehouse only when a row changed.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly INVENTORY: DurableObjectNamespace<Inventory>;
}

export interface Reservation {
  readonly ok: boolean;
  readonly qty: number;
}

export class Inventory extends DurableObject<Env> {
  protected stockOf(sku: string): number {
    const row = this.ctx.storage.sql
      .exec<{ qty: number }>(`SELECT qty FROM stock WHERE sku = ?`, sku)
      .toArray()[0];
    return row?.qty ?? 0;
  }

  async reserve(sku: string, qty: number): Promise<Reservation> {
    const stock = this.stockOf(sku);
    if (stock < qty) return { ok: false, qty: stock };
    await this.hold(sku, qty);
    this.ctx.storage.sql.exec(`UPDATE stock SET qty = qty - ? WHERE sku = ?`, qty, sku);
    return { ok: true, qty: this.stockOf(sku) };
  }

  protected async hold(sku: string, qty: number): Promise<void> {
    const res = await fetch("https://warehouse.example/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku, qty }),
    });
    if (!res.ok) throw new Error(`hold failed with ${res.status}`);
  }
}

/** The fix: take the stock in one guarded statement, then hold; give it back if the hold fails. */
export class FixedInventory extends Inventory {
  override async reserve(sku: string, qty: number): Promise<Reservation> {
    const taken = this.ctx.storage.sql.exec(
      `UPDATE stock SET qty = qty - ? WHERE sku = ? AND qty >= ?`,
      qty,
      sku,
      qty,
    ).rowsWritten;
    if (taken === 0) return { ok: false, qty: this.stockOf(sku) };
    try {
      await this.hold(sku, qty);
    } catch (err) {
      this.ctx.storage.sql.exec(`UPDATE stock SET qty = qty + ? WHERE sku = ?`, qty, sku);
      throw err;
    }
    return { ok: true, qty: this.stockOf(sku) };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { sku, qty } = (await request.json()) as { sku: string; qty: number };
    const store = env.INVENTORY.get(env.INVENTORY.idFromName("store-1"));
    try {
      return Response.json(await store.reserve(sku, qty));
    } catch {
      return new Response("inventory unavailable", { status: 503 });
    }
  },
};
