/**
 * The inventory Worker: stock per sku lives in a SQLite-backed Durable
 * Object, reservations are recorded in its own D1 database, and fulfilment
 * is a Workflow of its own. `reserve` is idempotent per reservation id;
 * `fulfil` starts one Workflow instance per order, named after it, so a
 * resend finds the instance there already.
 */

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
  readonly STOCK: DurableObjectNamespace<Stock>;
  readonly FULFILMENT: Workflow;
}

/** The stock of one sku: the amount available, and the reservations taken from it, by key. */
export class Stock extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, available INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS taken (reservation_id TEXT PRIMARY KEY, qty INTEGER NOT NULL)",
    );
  }

  /** Take `qty` for a reservation; a key seen before takes nothing more. Returns what is left. */
  async reserve(reservationId: string, sku: string, qty: number): Promise<number> {
    const seen = this.ctx.storage.sql
      .exec("SELECT qty FROM taken WHERE reservation_id = ?", reservationId)
      .toArray();
    if (seen.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO stock (sku, available) VALUES (?, 100) ON CONFLICT(sku) DO NOTHING",
        sku,
      );
      this.ctx.storage.sql.exec(
        "UPDATE stock SET available = available - ? WHERE sku = ?",
        qty,
        sku,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO taken (reservation_id, qty) VALUES (?, ?)",
        reservationId,
        qty,
      );
    }
    return this.available();
  }

  async available(): Promise<number> {
    const row = this.ctx.storage.sql.exec("SELECT available FROM stock").toArray()[0];
    return row ? Number(row["available"]) : 100;
  }
}

/** Fulfilment of one order: marks its reservation fulfilled. */
export class Fulfilment extends WorkflowEntrypoint<Env, { orderId: string }> {
  override async run(
    event: WorkflowEvent<{ orderId: string }>,
    step: WorkflowStep,
  ): Promise<string> {
    await step.do("mark fulfilled", async () => {
      await this.env.DB.prepare("UPDATE reservations SET status = 'fulfilled' WHERE order_id = ?1")
        .bind(event.payload.orderId)
        .run();
    });
    return event.payload.orderId;
  }
}

export default class Inventory extends WorkerEntrypoint<Env> {
  async reserve(
    reservationId: string,
    orderId: string,
    sku: string,
    qty: number,
  ): Promise<{ reservationId: string; available: number }> {
    const stock = this.env.STOCK.get(this.env.STOCK.idFromName(sku));
    const available = await stock.reserve(reservationId, sku, qty);
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO reservations (reservation_id, order_id, sku, qty) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(reservationId, orderId, sku, qty)
      .run();
    return { reservationId, available };
  }

  /** Start the order's fulfilment once: the instance is named after the order. */
  async fulfil(orderId: string): Promise<{ started: boolean }> {
    try {
      await this.env.FULFILMENT.create({ id: orderId, params: { orderId } });
      return { started: true };
    } catch (err) {
      // The instance exists from an earlier attempt: fulfilment is under way.
      if (String(err).includes("already exists")) return { started: false };
      throw err;
    }
  }
}
