/**
 * An object that runs jobs it does not wait for and bills each one: `start`
 * records the run, sets a watchdog alarm and answers at once; the job, queued
 * behind the answer, charges the customer through the billing Worker (a
 * service binding the object calls through its own `env`) and records the
 * run as charged. The watchdog settles whatever is still queued when it
 * fires, so a job lost with the object's memory is picked up again.
 *
 * Planted bug: the object charges first and records the charge after. When
 * the charge reached billing and the object did not get to record it (it was
 * reset right after the call, or the call's answer was lost), the run is
 * still queued, and the watchdog charges it a second time.
 */

import { DurableObject } from "cloudflare:workers";

/** The billing Worker's entrypoint, as the object calls it. */
export interface Billing {
  charge(runId: string, amountCents: number): Promise<{ chargeId: string }>;
}

export interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
  readonly SAFE_RUNNER: DurableObjectNamespace<FixedRunner>;
  readonly BILLING: Fetcher & Billing;
}

const watchdogMs = 30_000;
const amountCents = 500;

export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, charge_id TEXT)",
    );
  }

  async start(runId: string): Promise<{ accepted: true }> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO runs (id, status) VALUES (?, 'queued')",
      runId,
    );
    await this.ctx.storage.setAlarm(Date.now() + watchdogMs);
    // The work the answer does not wait for; what it leaves undone is the watchdog's.
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

  protected async settle(runId: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.statusOf(runId) !== "queued") return;
    // The planted bug: the charge leaves before anything records that it is being made.
    const { chargeId } = await this.env.BILLING.charge(runId, amountCents);
    this.recordCharge(runId, chargeId);
  }

  protected statusOf(runId: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)
      .toArray()[0]?.status;
  }

  protected recordCharge(runId: string, chargeId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE runs SET status = 'charged', charge_id = ? WHERE id = ?",
      chargeId,
      runId,
    );
  }
}

/**
 * The fix: the run is claimed, recorded as `charging`, in the same
 * synchronous block as the check, before the call leaves. A run the object
 * did not get to finish stays `charging`, for someone to reconcile with
 * billing; the watchdog settles only what is still `queued`, so no run is
 * charged twice.
 */
export class FixedRunner extends Runner {
  protected override async settle(runId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const claimed = this.ctx.storage.sql
      .exec(
        "UPDATE runs SET status = 'charging' WHERE id = ? AND status = 'queued' RETURNING id",
        runId,
      )
      .toArray();
    if (claimed.length === 0) return;
    const { chargeId } = await this.env.BILLING.charge(runId, amountCents);
    this.recordCharge(runId, chargeId);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runId = url.pathname.split("/").at(-1) ?? "";
    const namespace = url.searchParams.has("fixed") ? env.SAFE_RUNNER : env.RUNNER;
    const stub = namespace.get(namespace.idFromName("r"));
    return Response.json(await stub.start(runId), { status: 202 });
  },
} satisfies ExportedHandler<Env>;
