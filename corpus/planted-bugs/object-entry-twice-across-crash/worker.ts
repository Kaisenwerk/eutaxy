/**
 * An account object that takes deposits. Each deposit is written twice: an
 * entry in the ledger, a database every account shares, which the object
 * reaches through its own `env`; and the deposit in the object's own
 * storage, with the balance. The object's record is what makes a deposit
 * sent twice count once: a deposit it already holds is answered from it.
 *
 * Planted bug: the ledger entry is written first and the object's record
 * after it, and nothing ties the two. When the entry was written and the
 * object did not get to record the deposit (it was reset right after the
 * statement, or the statement's answer was lost), the caller's resend
 * finds no record and writes the entry a second time.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly ACCOUNT: DurableObjectNamespace<Account>;
  readonly SAFE_ACCOUNT: DurableObjectNamespace<FixedAccount>;
  readonly LEDGER: D1Database;
}

const table =
  "CREATE TABLE IF NOT EXISTS deposits (id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL)";

export class Account extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(table);
  }

  async deposit(depositId: string, amountCents: number): Promise<{ balanceCents: number }> {
    const held = this.ctx.storage.sql
      .exec("SELECT id FROM deposits WHERE id = ?", depositId)
      .toArray();
    if (held.length === 0) {
      // The bug: the entry leaves for the ledger before anything of the object's says it is being made.
      await this.env.LEDGER.prepare(
        "INSERT INTO entries (deposit_id, account, amount_cents) VALUES (?1, ?2, ?3)",
      )
        .bind(depositId, "acct-1", amountCents)
        .run();
      this.ctx.storage.sql.exec(
        "INSERT INTO deposits (id, amount_cents) VALUES (?, ?)",
        depositId,
        amountCents,
      );
    }
    return { balanceCents: balanceOf(this.ctx.storage.sql) };
  }
}

/**
 * The fix: the entry is one that can be written twice. Its statement
 * inserts only when the ledger holds no entry for the deposit, so a resend
 * after an entry the object did not get to record writes nothing.
 */
export class FixedAccount extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(table);
  }

  async deposit(depositId: string, amountCents: number): Promise<{ balanceCents: number }> {
    const held = this.ctx.storage.sql
      .exec("SELECT id FROM deposits WHERE id = ?", depositId)
      .toArray();
    if (held.length === 0) {
      await this.env.LEDGER.prepare(
        "INSERT INTO entries (deposit_id, account, amount_cents) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM entries WHERE deposit_id = ?1)",
      )
        .bind(depositId, "acct-1", amountCents)
        .run();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO deposits (id, amount_cents) VALUES (?, ?)",
        depositId,
        amountCents,
      );
    }
    return { balanceCents: balanceOf(this.ctx.storage.sql) };
  }
}

function balanceOf(sql: SqlStorage): number {
  return sql
    .exec<{ total: number }>("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM deposits")
    .one().total;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const depositId = url.pathname.split("/")[2] ?? "";
    const namespace = url.searchParams.has("fixed") ? env.SAFE_ACCOUNT : env.ACCOUNT;
    const account = namespace.get(namespace.idFromName("acct-1"));
    const { amountCents } = await request.json<{ amountCents: number }>();
    return Response.json(await account.deposit(depositId, amountCents));
  },
} satisfies ExportedHandler<Env>;
