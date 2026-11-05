/**
 * The same pool, made safe to retry: `acquire` looks for the project's
 * lease first and hands it back when the token matches, so a retry after a
 * lost answer gets the runner it already holds. `eutaxy check
 * ./leases.fixed.sim.ts` reports BOUNDED.
 */

import { type Lease, LeasePool as PlantedPool } from "./worker.ts";

export { default } from "./worker.ts";

export class LeasePool extends PlantedPool {
  override async acquire(project: string, token: string): Promise<Lease | null> {
    const held = this.ctx.storage.sql
      .exec<{ id: string; token: string; expires_at: number }>(
        "SELECT id, token, expires_at FROM slots WHERE project = ?",
        project,
      )
      .toArray()[0];
    // A retry gets its own lease back; another caller for the same project waits its turn.
    if (held)
      return held.token === token ? { slot: held.id, token, expiresAt: held.expires_at } : null;
    return super.acquire(project, token);
  }
}
