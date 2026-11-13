/**
 * Three kinds of object calling one another through their own env. A cart
 * takes a unit of an item from the item's shelf, and keeps the item once
 * the shelf has answered. The shelf holds one unit and keys a take by the
 * cart, so a cart that asks twice (its caller's resend, after the first
 * answer was lost or the cart was reset) holds the unit once, and a second
 * cart is turned away. Before it gives a unit the shelf asks the cart,
 * which is waiting on it, how many it may hold. After its answer the shelf
 * tells the auditor what it gave, and the auditor calls back to say it has
 * it; a watchdog alarm tells the auditor again whatever a fault kept from
 * arriving. A cart asked for its size asks itself, through its own
 * namespace, and hands the answer on.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly CART: DurableObjectNamespace<Cart>;
  readonly SHELF: DurableObjectNamespace<Shelf>;
  readonly AUDIT: DurableObjectNamespace<Audit>;
}

const units = 1;
const watchdogMs = 30_000;

export class Audit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (cart TEXT PRIMARY KEY, item TEXT NOT NULL)",
    );
  }

  /** Keyed by the cart: noting a take twice is noting it once. */
  async note(item: string, cart: string): Promise<{ noted: true }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO seen (cart, item) VALUES (?, ?)", cart, item);
    // Back into the shelf, whose work is waiting on this call: its input gate is open meanwhile.
    await this.env.SHELF.get(this.env.SHELF.idFromName(item)).audited(cart);
    return { noted: true };
  }
}

export class Shelf extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS takes (cart TEXT PRIMARY KEY, unit INTEGER NOT NULL, audited INTEGER NOT NULL DEFAULT 0)",
    );
  }

  /** Give the cart a unit, the one it holds already if it has one; none when all are taken. */
  async take(item: string, cart: string): Promise<{ taken: boolean }> {
    const sql = this.ctx.storage.sql;
    const [held] = sql.exec("SELECT unit FROM takes WHERE cart = ?", cart).toArray();
    if (held) return { taken: true };
    // Back into the cart, which is waiting on this call.
    const { limit } = await this.env.CART.get(this.env.CART.idFromName(cart)).limit();
    // Counted and written with no await between them: no other take gets in between.
    const [{ n } = { n: 0 }] = sql.exec<{ n: number }>("SELECT count(*) AS n FROM takes").toArray();
    if (limit < 1 || n >= units) return { taken: false };
    sql.exec("INSERT OR IGNORE INTO takes (cart, unit) VALUES (?, ?)", cart, n + 1);
    await this.ctx.storage.put("item", item);
    await this.ctx.storage.setAlarm(Date.now() + watchdogMs);
    // The answer does not wait for the auditor; what stays unaudited is the watchdog's.
    void this.audit(item, cart).catch(() => {});
    return { taken: true };
  }

  /** The auditor's word that it has the take. */
  async audited(cart: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE takes SET audited = 1 WHERE cart = ?", cart);
  }

  /** The watchdog: whatever was given and not yet audited is told again. */
  override async alarm(): Promise<void> {
    const item = (await this.ctx.storage.get<string>("item")) ?? "";
    const open = this.ctx.storage.sql
      .exec<{ cart: string }>("SELECT cart FROM takes WHERE audited = 0")
      .toArray();
    for (const { cart } of open) await this.audit(item, cart);
  }

  private async audit(item: string, cart: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await this.env.AUDIT.get(this.env.AUDIT.idFromName("log")).note(item, cart);
  }
}

export class Cart extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS items (item TEXT PRIMARY KEY, holder TEXT NOT NULL)",
    );
  }

  /** Take a unit of the item from its shelf and keep the item. */
  async add(cart: string, item: string): Promise<{ added: boolean }> {
    const shelf = this.env.SHELF.get(this.env.SHELF.idFromName(item));
    const { taken } = await shelf.take(item, cart);
    if (!taken) return { added: false };
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO items (item, holder) VALUES (?, ?)",
      item,
      cart,
    );
    return { added: true };
  }

  /** How many units of an item this cart may hold. */
  async limit(): Promise<{ limit: number }> {
    return { limit: 1 };
  }

  async size(): Promise<{ size: number }> {
    const [{ n } = { n: 0 }] = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM items")
      .toArray();
    return { size: n };
  }

  /** The cart's size, asked of itself through its own namespace, as any other caller would. */
  async summary(): Promise<{ size: number }> {
    return this.env.CART.get(this.ctx.id).size();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, , name = "", item = ""] = new URL(request.url).pathname.split("/");
    const cart = env.CART.get(env.CART.idFromName(name));
    if (request.method === "GET") return Response.json(await cart.summary());
    // Turned away is an answer, not a failure: the caller does not ask again.
    return Response.json(await cart.add(name, item));
  },
} satisfies ExportedHandler<Env>;
