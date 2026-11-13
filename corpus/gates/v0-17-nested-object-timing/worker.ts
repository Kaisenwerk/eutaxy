/**
 * The v0.16 gate's object, reached through another object. `Runner` is the
 * same class in the same three timings (`slow` sleeps on a timer of its own
 * before it answers; `eager` asks the model before answering and does not
 * wait for the reply; `hashed` answers, then does real work that is not an
 * effect before it asks the model). `Front` is the object the Worker calls:
 * it notes the run, passes the call on through its own env, and notes the
 * answer, so the runner's timing happens inside another object's call.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly FRONT: DurableObjectNamespace<Front>;
  readonly RUNNER: DurableObjectNamespace<Runner>;
}

type Timing = "slow" | "eager" | "hashed";

export class Front extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, answered INTEGER NOT NULL)",
    );
  }

  /** Note the run, pass it to the runner, note that the runner answered, and answer with what it said. */
  async pass(method: Timing, runId: string): Promise<{ total?: number | null; accepted?: true }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO passes (id, answered) VALUES (?, 0)", runId);
    const answer = await this.env.RUNNER.getByName("r")[method](runId);
    this.ctx.storage.sql.exec("UPDATE passes SET answered = 1 WHERE id = ?", runId);
    return { ...answer };
  }
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

  /** Waits on a timer of its own, then does the job, then answers with the total. */
  async slow(runId: string): Promise<{ total: number | null }> {
    this.accept(runId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { total: await this.job(runId) };
  }

  /** Asks the model before answering and does not wait for the reply. */
  async eager(runId: string): Promise<{ accepted: true }> {
    this.accept(runId);
    void this.job(runId);
    return { accepted: true };
  }

  /** Answers, then hashes the run id (real work, not an effect) before asking the model. */
  async hashed(runId: string): Promise<{ accepted: true }> {
    this.accept(runId);
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(runId))
      .then((digest) => this.job(runId, digest.byteLength));
    return { accepted: true };
  }

  private accept(runId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO runs (id, status, steps) VALUES (?, 'queued', 0)",
      runId,
    );
  }

  /** Ask the model for the plan and add its steps to the total; the total the job brought the object to. */
  private async job(runId: string, salt = 0): Promise<number | null> {
    try {
      const res = await fetch("https://model.example/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, salt }),
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
      return total?.steps ?? null;
    } catch {
      this.ctx.storage.sql.exec("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
      return null;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/(slow|eager|hashed)\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    const [, method, runId] = match as unknown as [string, Timing, string];
    return Response.json(await env.FRONT.getByName("f").pass(method, runId));
  },
} satisfies ExportedHandler<Env>;
