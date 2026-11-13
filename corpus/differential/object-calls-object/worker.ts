/**
 * Three kinds of object calling one another through their own env: a cart
 * takes a unit of an item from the item's shelf and keeps the item; the
 * shelf, which holds one unit, asks the cart that is waiting on it how
 * many it may hold, and tells the auditor what it gave before it answers;
 * the auditor calls back into the shelf to say it has it. A cart asked
 * who holds an item asks the shelf.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly CART: DurableObjectNamespace<Cart>;
  readonly SHELF: DurableObjectNamespace<Shelf>;
  readonly AUDIT: DurableObjectNamespace<Audit>;
}

const units = 1;

export class Audit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (cart TEXT PRIMARY KEY, item TEXT NOT NULL)",
    );
  }

  async note(item: string, cart: string): Promise<{ noted: true }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO seen (cart, item) VALUES (?, ?)", cart, item);
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

  async take(item: string, cart: string): Promise<{ taken: boolean }> {
    const sql = this.ctx.storage.sql;
    const [held] = sql.exec("SELECT unit FROM takes WHERE cart = ?", cart).toArray();
    if (held) return { taken: true };
    const { limit } = await this.env.CART.get(this.env.CART.idFromName(cart)).limit();
    const [{ n } = { n: 0 }] = sql.exec<{ n: number }>("SELECT count(*) AS n FROM takes").toArray();
    if (limit < 1 || n >= units) return { taken: false };
    sql.exec("INSERT OR IGNORE INTO takes (cart, unit) VALUES (?, ?)", cart, n + 1);
    await this.env.AUDIT.get(this.env.AUDIT.idFromName("log")).note(item, cart);
    return { taken: true };
  }

  async audited(cart: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE takes SET audited = 1 WHERE cart = ?", cart);
  }

  async holders(): Promise<{ holders: string[] }> {
    const rows = this.ctx.storage.sql
      .exec<{ cart: string }>("SELECT cart FROM takes ORDER BY unit")
      .toArray();
    return { holders: rows.map((r) => r.cart) };
  }
}

export class Cart extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS items (item TEXT PRIMARY KEY, holder TEXT NOT NULL)",
    );
  }

  async add(cart: string, item: string): Promise<{ added: boolean }> {
    const { taken } = await this.env.SHELF.get(this.env.SHELF.idFromName(item)).take(item, cart);
    if (!taken) return { added: false };
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO items (item, holder) VALUES (?, ?)",
      item,
      cart,
    );
    return { added: true };
  }

  async limit(): Promise<{ limit: number }> {
    return { limit: 1 };
  }

  /** Who holds the item, as the shelf says. */
  async holders(item: string): Promise<{ holders: string[] }> {
    // Copied, not handed on: the runtime's own result keeps the call into the shelf open until it
    // is collected, and the raw run's shelf could then not be evicted for the next run.
    const { holders } = await this.env.SHELF.get(this.env.SHELF.idFromName(item)).holders();
    return { holders: [...holders] };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, , cart = "", item = ""] = new URL(request.url).pathname.split("/");
    const stub = env.CART.get(env.CART.idFromName(cart));
    if (request.method === "GET") return Response.json(await stub.holders(item));
    const { added } = await stub.add(cart, item);
    return Response.json({ added }, { status: added ? 201 : 409 });
  },
} satisfies ExportedHandler<Env>;
