/**
 * A correct rollup job on a Cron Trigger: every tick it counts the events
 * recorded so far and upserts one row for the tick, keyed on
 * `scheduledTime`, so a re-run of the tick writes the same row again rather
 * than a second one; a tick that finds no events asks for no re-run.
 */

export interface Env {
  readonly DB: D1Database;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    const n = count?.n ?? 0;
    if (n === 0) {
      controller.noRetry();
      throw new Error("nothing to roll up yet");
    }
    await env.DB.prepare(
      "INSERT INTO rollups (tick, cron, n) VALUES (?1, ?2, ?3) ON CONFLICT(tick) DO UPDATE SET n = excluded.n",
    )
      .bind(controller.scheduledTime, controller.cron, n)
      .run();
    await env.DB.prepare("INSERT INTO events (at) VALUES (?1)")
      .bind(controller.scheduledTime)
      .run();
  },
} satisfies ExportedHandler<Env>;
