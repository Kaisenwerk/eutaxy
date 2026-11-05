/**
 * A pool of build runners shared by many projects. A Durable Object hands
 * out a runner for five minutes, records each grant for billing, and its
 * alarm takes expired leases back. The Worker asks the pool for a lease and
 * retries a call that failed, with the same token. Run `eutaxy check
 * ./leases.sim.ts` to see what the retry does when only the answer was lost.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly POOL: DurableObjectNamespace<LeasePool>;
}

export interface Lease {
  readonly slot: string;
  readonly token: string;
  readonly expiresAt: number;
}

export const leaseMs = 5 * 60 * 1000;

export class LeasePool extends DurableObject<Env> {
  /** The first free runner, leased to `project` until five minutes from now; null when none is free. */
  async acquire(project: string, token: string): Promise<Lease | null> {
    const sql = this.ctx.storage.sql;
    const free = sql
      .exec<{ id: string }>("SELECT id FROM slots WHERE project IS NULL ORDER BY id LIMIT 1")
      .toArray()[0];
    if (!free) return null;
    return this.grant(free.id, project, token);
  }

  protected async grant(slot: string, project: string, token: string): Promise<Lease> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const expiresAt = now + leaseMs;
    sql.exec(
      "UPDATE slots SET project = ?, token = ?, expires_at = ? WHERE id = ?",
      project,
      token,
      expiresAt,
      slot,
    );
    sql.exec(
      "INSERT INTO grants (token, project, slot, granted_at) VALUES (?, ?, ?, ?)",
      token,
      project,
      slot,
      now,
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || expiresAt < alarm) await this.ctx.storage.setAlarm(expiresAt);
    return { slot, token, expiresAt };
  }

  /** Takes back every expired lease, closes its grant, and wakes again for the next expiry. */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const expired = sql
      .exec<{ id: string; token: string }>(
        "SELECT id, token FROM slots WHERE project IS NOT NULL AND expires_at <= ?",
        now,
      )
      .toArray();
    for (const { id, token } of expired) {
      sql.exec("UPDATE grants SET ended_at = ? WHERE token = ? AND slot = ?", now, token, id);
      sql.exec("UPDATE slots SET project = NULL, token = NULL, expires_at = NULL WHERE id = ?", id);
    }
    const next = sql
      .exec<{ at: number | null }>(
        "SELECT MIN(expires_at) AS at FROM slots WHERE project IS NOT NULL",
      )
      .one().at;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/projects\/([\w-]+)\/lease$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    const pool = env.POOL.getByName("pool");
    const token = crypto.randomUUID();
    // One retry: a call can fail before it reaches the pool.
    for (let attempt = 1; ; attempt++) {
      try {
        const lease = await pool.acquire(match[1], token);
        return lease ? Response.json(lease) : new Response("no free runner", { status: 409 });
      } catch {
        if (attempt === 2) return new Response("pool unavailable", { status: 503 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
