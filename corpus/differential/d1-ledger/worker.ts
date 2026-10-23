/**
 * A ledger consumer that exercises every modelled D1 operation on each
 * message: prepare/bind/run, first, all, raw, batch and exec. Correct by
 * construction (idempotent on posting_id), so the differential check is about
 * the proxies, not the Worker.
 */

export interface Env {
  readonly DB: D1Database;
}

export interface Posting {
  readonly postingId: string;
  readonly account: string;
  readonly delta: number;
}

export default {
  async queue(batch: MessageBatch<Posting>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { postingId, account, delta } = message.body;
      await env.DB.prepare("INSERT OR IGNORE INTO accounts (name, balance) VALUES (?1, 0)")
        .bind(account)
        .run();
      const existing = await env.DB.prepare("SELECT id FROM postings WHERE posting_id = ?1")
        .bind(postingId)
        .first<{ id: number }>();
      if (existing === null) {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO postings (posting_id, account, delta) VALUES (?1, ?2, ?3)",
          ).bind(postingId, account, delta),
          env.DB.prepare("UPDATE accounts SET balance = balance + ?1 WHERE name = ?2").bind(
            delta,
            account,
          ),
        ]);
      }
      // A small pause between the write and the read-back, as a rate-limited consumer might do.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const all = await env.DB.prepare("SELECT name, balance FROM accounts ORDER BY name").all<{
        name: string;
        balance: number;
      }>();
      const raw = await env.DB.prepare("SELECT count(*) FROM postings").raw<[number]>();
      if (all.results.length < 1 || (raw[0]?.[0] ?? 0) < 1) throw new Error("ledger inconsistent");
      await env.DB.exec("UPDATE accounts SET touched = touched + 1");
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Posting>;
