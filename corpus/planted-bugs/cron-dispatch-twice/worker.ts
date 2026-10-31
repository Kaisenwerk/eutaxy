/**
 * A reconciliation job on a Cron Trigger: every tick, it dispatches each
 * pending row to the dispatcher service and marks the row sent.
 *
 * Planted bug: the dispatch and the mark are two steps with nothing between
 * them to make the dispatch idempotent. When the invocation dies after the
 * dispatch left and before the mark, the re-run the operator configured for
 * failed ticks finds the row still pending and dispatches it again.
 */

export interface Env {
  readonly DB: D1Database;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const pending = await env.DB.prepare(
      "SELECT id, payload FROM dispatches WHERE status = 'pending' ORDER BY id",
    ).all<{ id: string; payload: string }>();
    for (const row of pending.results) {
      const response = await fetch("https://dispatcher.example/v1/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dispatchId: row.id, payload: row.payload }),
      });
      if (!response.ok) throw new Error(`dispatch ${row.id} failed with ${response.status}`);
      await env.DB.prepare("UPDATE dispatches SET status = 'sent' WHERE id = ?1")
        .bind(row.id)
        .run();
    }
  },
} satisfies ExportedHandler<Env>;
