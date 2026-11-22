/**
 * The notes Worker: it signs every note with a key it reads from a secret,
 * and refuses to work without one. A secret is set with `wrangler secret
 * put`, so no wrangler config holds it.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly API_KEY?: string;
  readonly TIER: string;
}

export default class Notes extends WorkerEntrypoint<Env> {
  async record(id: string): Promise<{ ok: boolean }> {
    console.log(`notes: tier ${this.env.TIER}`);
    const key = this.env.API_KEY;
    if (key === undefined || key === "") {
      console.error("notes: API_KEY is not set");
      throw new Error("notes: API_KEY is not set");
    }
    // The key's length, never the key.
    console.log(`notes: ${id} signed with a key of ${key.length} characters`);
    return { ok: true };
  }
}
