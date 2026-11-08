/**
 * An object that answers a call and goes on with work it did not await, the
 * way an agent runs a job: `start` records the run, kicks the job off with
 * `void`, and answers at once. The job starts a tick later, as a job queued
 * behind the answer does, asks an external model for the plan and writes the
 * result into the object's own tables, adding its steps to the running total
 * in one statement, so two jobs at once cannot lose each other's; each run
 * records the total it brought the object to.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
}

export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, steps INTEGER NOT NULL, total INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS totals (id TEXT PRIMARY KEY, steps INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO totals (id, steps) VALUES ('all', 0)");
  }

  async start(runId: string): Promise<{ accepted: true }> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO runs (id, status, steps) VALUES (?, 'queued', 0)",
      runId,
    );
    // The work the answer does not wait for.
    void this.execute(runId);
    return { accepted: true };
  }

  private async execute(runId: string): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const res = await fetch("https://model.example/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (!res.ok) throw new Error(`the model answered ${res.status}`);
      const { steps } = (await res.json()) as { steps: number };
      const [total] = this.ctx.storage.sql
        .exec<{ steps: number }>(
          "UPDATE totals SET steps = steps + ? WHERE id = 'all' RETURNING steps",
          steps,
        )
        .toArray();
      this.ctx.storage.sql.exec(
        "UPDATE runs SET status = 'done', steps = ?, total = ? WHERE id = ?",
        steps,
        total?.steps ?? null,
        runId,
      );
    } catch {
      // Nothing awaits this work: a failure is recorded where a caller can see it later.
      this.ctx.storage.sql.exec("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/runs\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    return Response.json(await env.RUNNER.getByName("r").start(match[1]));
  },
} satisfies ExportedHandler<Env>;
