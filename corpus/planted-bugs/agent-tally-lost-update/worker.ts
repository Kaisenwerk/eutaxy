/**
 * A tally kept by an Agent (Cloudflare Agents SDK): its state is the count,
 * each hit is audited through an external API, and a schedule flushes the
 * count into a SQL table of the Agent's own.
 *
 * Planted bug: a hit reads the count, awaits the audit call, then writes
 * the count plus one. The Agent is a Durable Object, whose input gate is
 * open while it awaits an outbound fetch, so two hits at once both read 0
 * and both write 1: a lost update, and the flush records 1. The fix writes
 * the state before the await, so the second hit reads 1.
 */

import { Agent, routeAgentRequest } from "agents";

export interface Env {
  readonly TALLY: DurableObjectNamespace<Tally>;
}

export interface TallyState {
  readonly count: number;
}

export class Tally extends Agent<Env, TallyState> {
  override initialState: TallyState = { count: 0 };

  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json(this.state);
    const count = this.state.count;
    if (count === 0) {
      this.sql`CREATE TABLE IF NOT EXISTS flushes (count INTEGER NOT NULL)`;
      await this.schedule(30, "flush");
    }
    await this.audit(count + 1);
    this.setState({ count: count + 1 });
    return Response.json(this.state);
  }

  /** The scheduled callback: the count as the Agent holds it, into its own table. */
  async flush(): Promise<void> {
    this.sql`INSERT INTO flushes (count) VALUES (${this.state.count})`;
  }

  protected async audit(count: number): Promise<void> {
    const res = await fetch("https://audit.example/hits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
    });
    if (!res.ok) throw new Error(`audit failed with ${res.status}`);
  }
}

/** The fix: the state is written before the outbound call, so a concurrent hit reads it. */
export class FixedTally extends Tally {
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json(this.state);
    const count = this.state.count;
    if (count === 0) {
      this.sql`CREATE TABLE IF NOT EXISTS flushes (count INTEGER NOT NULL)`;
      await this.schedule(30, "flush");
    }
    this.setState({ count: count + 1 });
    await this.audit(count + 1);
    return Response.json(this.state);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
