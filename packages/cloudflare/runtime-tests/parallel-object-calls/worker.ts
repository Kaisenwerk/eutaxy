/**
 * A Worker that calls two objects at once: a transfer posts its debit to one
 * account and its credit to the other and awaits both together, so the two
 * calls are in flight at the same time and either may land first. Each
 * account answers and then reports the entry to an audit service, work the
 * answer does not wait for.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly ACCOUNT: DurableObjectNamespace<Account>;
}

export class Account extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, amount INTEGER NOT NULL)",
    );
  }

  /** Record one side of a transfer, once, and answer the balance it leaves. */
  async post(id: string, amount: number): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO entries (id, amount) VALUES (?, ?)",
      id,
      amount,
    );
    const [row] = this.ctx.storage.sql
      .exec<{ balance: number }>("SELECT COALESCE(SUM(amount), 0) AS balance FROM entries")
      .toArray();
    // The work the answer does not wait for.
    void this.audit(id);
    return row?.balance ?? 0;
  }

  private async audit(id: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fetch("https://audit.example/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/transfers\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    const id = match[1];
    // Both sides at once: two calls in flight, in parallel, inside this one invocation.
    const [from, to] = await Promise.all([
      env.ACCOUNT.getByName("from").post(id, -5),
      env.ACCOUNT.getByName("to").post(id, 5),
    ]);
    return Response.json({ from, to });
  },
} satisfies ExportedHandler<Env>;
