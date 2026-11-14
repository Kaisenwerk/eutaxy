/**
 * An object that calls other Workers through its own service bindings, in
 * both places an object can: inside a call (`quote` asks the model Worker
 * and answers with what it said) and in work the answer does not wait for
 * (`start` records the run and answers; the job behind it asks the model
 * for the plan, bills the run through the billing Worker and records the
 * charge). The run is claimed, recorded as `charging`, in the same
 * synchronous block as the check and before the charge leaves, so the
 * watchdog alarm, which settles whatever is still `queued`, never bills a
 * run twice: one the object did not get to finish stays `charging`.
 */

import { DurableObject } from "cloudflare:workers";

/** The model Worker's entrypoint, as the object calls it. */
export interface Model {
  estimate(runId: string): Promise<{ steps: number }>;
  plan(runId: string): Promise<{ steps: number }>;
}

/** The billing Worker's entrypoint, as the object calls it. */
export interface Billing {
  charge(runId: string, steps: number): Promise<{ chargeId: string }>;
}

export interface Env {
  readonly JOBS: DurableObjectNamespace<Jobs>;
  readonly MODEL: Fetcher & Model;
  readonly BILLING: Fetcher & Billing;
}

const watchdogMs = 30_000;

export class Jobs extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, steps INTEGER, charge_id TEXT)",
    );
  }

  /** Inside the call: the model's estimate is the answer. */
  async quote(runId: string): Promise<{ steps: number }> {
    return this.env.MODEL.estimate(runId);
  }

  async start(runId: string): Promise<{ accepted: true }> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO runs (id, status) VALUES (?, 'queued')",
      runId,
    );
    await this.ctx.storage.setAlarm(Date.now() + watchdogMs);
    // The work the answer does not wait for; what it leaves queued is the watchdog's.
    void this.settle(runId).catch(() => {});
    return { accepted: true };
  }

  /** The watchdog: whatever is still queued is settled again. */
  override async alarm(): Promise<void> {
    const queued = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM runs WHERE status = 'queued'")
      .toArray();
    for (const { id } of queued) await this.settle(id);
  }

  private async settle(runId: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { steps } = await this.env.MODEL.plan(runId);
    // Claimed before the charge leaves: a second settle of the same run finds nothing to claim.
    const claimed = this.ctx.storage.sql
      .exec(
        "UPDATE runs SET status = 'charging', steps = ? WHERE id = ? AND status = 'queued' RETURNING id",
        steps,
        runId,
      )
      .toArray();
    if (claimed.length === 0) return;
    const { chargeId } = await this.env.BILLING.charge(runId, steps);
    this.ctx.storage.sql.exec(
      "UPDATE runs SET status = 'charged', charge_id = ? WHERE id = ?",
      chargeId,
      runId,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, action, runId = ""] = new URL(request.url).pathname.split("/");
    const jobs = env.JOBS.get(env.JOBS.idFromName("j"));
    if (action === "quote") return Response.json(await jobs.quote(runId));
    return Response.json(await jobs.start(runId), { status: 202 });
  },
} satisfies ExportedHandler<Env>;
