/**
 * The turns Worker: one object per turn. `start` records the turn and
 * answers; the work behind the answer asks the model Worker for the reply,
 * records it, and tells the Worker that asked, through the object's own
 * service binding back to it, that the turn has ended.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly TURN: DurableObjectNamespace<Turn>;
  readonly MODEL: Fetcher & { complete(id: string): Promise<{ reply: string }> };
  readonly FRONT: Fetcher & { turnEnded(id: string, reply: string): Promise<void> };
}

export class Turn extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, status TEXT NOT NULL, reply TEXT)",
    );
  }

  async start(id: string): Promise<{ accepted: true }> {
    const started = this.ctx.storage.sql
      .exec("INSERT OR IGNORE INTO turns (id, status) VALUES (?, 'running') RETURNING id", id)
      .toArray();
    // A start that is resent finds the turn there and starts nothing.
    if (started.length === 1) void this.run(id).catch(() => {});
    return { accepted: true };
  }

  async replyOf(id: string): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ reply: string | null }>("SELECT reply FROM turns WHERE id = ?", id)
      .toArray()[0];
    return row?.reply ?? null;
  }

  private async run(id: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { reply } = await this.env.MODEL.complete(id);
    this.ctx.storage.sql.exec(
      "UPDATE turns SET status = 'done', reply = ? WHERE id = ?",
      reply,
      id,
    );
    // Back into the Worker that asked: its Workflow is waiting for this. A notice that got no answer
    // is sent once more: whether the first arrived is not known here.
    try {
      await this.env.FRONT.turnEnded(id, reply);
    } catch {
      await this.env.FRONT.turnEnded(id, reply);
    }
  }
}

export default class Turns extends WorkerEntrypoint<Env> {
  async startTurn(id: string): Promise<{ accepted: true }> {
    await this.env.TURN.get(this.env.TURN.idFromName(id)).start(id);
    return { accepted: true };
  }

  async replyOf(id: string): Promise<string | null> {
    return this.env.TURN.get(this.env.TURN.idFromName(id)).replyOf(id);
  }
}
