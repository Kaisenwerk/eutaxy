/**
 * A lease pool in a Durable Object, and the Worker that takes a lease for a
 * project before starting work for it.
 *
 * Planted bug: `acquire` hands out the first free slot without checking
 * whether the project already holds one. The Worker retries a failed call
 * with the same token, which is right for a call that never reached the
 * pool, but when the pool committed the lease and only the answer was lost,
 * the retry takes a second slot: one project, two leases. The fix looks the
 * project up first and returns its existing lease when the token matches.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly POOL: DurableObjectNamespace<LeasePool>;
}

export interface Slot {
  readonly id: string;
  lease: { readonly project: string; readonly token: string } | null;
}

export interface Lease {
  readonly slot: string;
  readonly token: string;
}

export class LeasePool extends DurableObject<Env> {
  async acquire(project: string, token: string): Promise<Lease | null> {
    return this.ctx.storage.transaction(async (tx) => {
      const slots = [...(await tx.list<Slot>({ prefix: "slot:" })).values()];
      const free = slots.find((s) => s.lease === null);
      if (!free) return null;
      free.lease = { project, token };
      await tx.put(`slot:${free.id}`, free);
      return { slot: free.id, token };
    });
  }
}

/** The pool with the fix: an existing lease for the same project and token is returned again. */
export class FixedLeasePool extends DurableObject<Env> {
  async acquire(project: string, token: string): Promise<Lease | null> {
    return this.ctx.storage.transaction(async (tx) => {
      const slots = [...(await tx.list<Slot>({ prefix: "slot:" })).values()];
      const owned = slots.find((s) => s.lease?.project === project);
      if (owned) return owned.lease?.token === token ? { slot: owned.id, token } : null;
      const free = slots.find((s) => s.lease === null);
      if (!free) return null;
      free.lease = { project, token };
      await tx.put(`slot:${free.id}`, free);
      return { slot: free.id, token };
    });
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
        return lease ? Response.json(lease) : new Response("no free slot", { status: 409 });
      } catch {
        if (attempt === 2) return new Response("pool unavailable", { status: 503 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
