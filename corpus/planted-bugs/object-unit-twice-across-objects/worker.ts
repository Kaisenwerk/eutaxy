/**
 * A cart object that takes units of an item from the item's shelf, another
 * object, which it calls through its own `env`. The shelf holds two units
 * and gives one to each cart that asks; the cart keeps the item once the
 * shelf has answered.
 *
 * Planted bug: the shelf gives a unit for every call. When a take was made
 * and the cart did not get to keep the item (the shelf's answer was lost,
 * or the cart was reset right after the call), the cart's caller sends its
 * request again, the cart asks again, and the shelf gives the same cart a
 * second unit.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly CART: DurableObjectNamespace<Cart>;
  readonly SHELF: DurableObjectNamespace<Shelf>;
  readonly SAFE_SHELF: DurableObjectNamespace<FixedShelf>;
}

const units = 2;
const table =
  "CREATE TABLE IF NOT EXISTS takes (unit INTEGER PRIMARY KEY AUTOINCREMENT, cart TEXT NOT NULL)";

export class Shelf extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(table);
  }

  async take(cart: string): Promise<{ taken: boolean }> {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT unit FROM takes").toArray().length >= units) return { taken: false };
    // The bug: nothing says this cart has been given a unit already.
    sql.exec("INSERT INTO takes (cart) VALUES (?)", cart);
    return { taken: true };
  }
}

/** The fix: a take is keyed by the cart, so a cart that asks twice is given the unit it has. */
export class FixedShelf extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(table);
  }

  async take(cart: string): Promise<{ taken: boolean }> {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT unit FROM takes WHERE cart = ?", cart).toArray().length > 0)
      return { taken: true };
    if (sql.exec("SELECT unit FROM takes").toArray().length >= units) return { taken: false };
    sql.exec("INSERT INTO takes (cart) VALUES (?)", cart);
    return { taken: true };
  }
}

export class Cart extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS items (item TEXT PRIMARY KEY)");
  }

  async add(cart: string, item: string, fixed: boolean): Promise<{ added: boolean }> {
    const shelves = fixed ? this.env.SAFE_SHELF : this.env.SHELF;
    const { taken } = await shelves.get(shelves.idFromName(item)).take(cart);
    if (taken) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO items (item) VALUES (?)", item);
    return { added: taken };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, , cart = "", item = ""] = url.pathname.split("/");
    const stub = env.CART.get(env.CART.idFromName(cart));
    return Response.json(await stub.add(cart, item, url.searchParams.has("fixed")));
  },
} satisfies ExportedHandler<Env>;
