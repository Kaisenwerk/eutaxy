/**
 * An object that runs jobs it does not wait for, the way an agent does:
 * `start` records the run, kicks the job off with `void` and answers at once;
 * the job asks an external model for the plan and adds its steps to a running
 * total, finishing after the answer.
 *
 * Planted bug: the total is read before the model call and written after
 * it. Nothing awaits the job, so a second call enters the object while the
 * first job awaits the model: both read 0, and the total ends at one job's
 * steps. The fix adds the steps in one statement.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
}

abstract class JobRunner extends DurableObject<Env> {
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
    void this.execute(runId);
    return { accepted: true };
  }

  /** Plan the job and add its steps to the total: the steps, and the total the job brought the object to. */
  protected abstract count(
    planned: () => Promise<number>,
  ): Promise<{ steps: number; total: number }>;

  private async execute(runId: string): Promise<void> {
    try {
      const { steps, total } = await this.count(() => this.plan(runId));
      this.ctx.storage.sql.exec(
        "UPDATE runs SET status = 'done', steps = ?, total = ? WHERE id = ?",
        steps,
        total,
        runId,
      );
    } catch {
      this.ctx.storage.sql.exec("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
    }
  }

  protected async plan(runId: string): Promise<number> {
    const res = await fetch("https://model.example/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) throw new Error(`the model answered ${res.status}`);
    return ((await res.json()) as { steps: number }).steps;
  }
}

export class Runner extends JobRunner {
  protected override async count(planned: () => Promise<number>) {
    // The bug: the total read here is stale by the time the model has answered.
    const [row] = this.ctx.storage.sql
      .exec<{ steps: number }>("SELECT steps FROM totals WHERE id = 'all'")
      .toArray();
    const steps = await planned();
    const total = (row?.steps ?? 0) + steps;
    this.ctx.storage.sql.exec("UPDATE totals SET steps = ? WHERE id = 'all'", total);
    return { steps, total };
  }
}

/** The fix: the steps are added to the total in one statement, after the model answered. */
export class FixedRunner extends JobRunner {
  protected override async count(planned: () => Promise<number>) {
    const steps = await planned();
    const [row] = this.ctx.storage.sql
      .exec<{ steps: number }>(
        "UPDATE totals SET steps = steps + ? WHERE id = 'all' RETURNING steps",
        steps,
      )
      .toArray();
    return { steps, total: row?.steps ?? 0 };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/runs\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    return Response.json(await env.RUNNER.getByName("r").start(match[1]));
  },
} satisfies ExportedHandler<Env>;
