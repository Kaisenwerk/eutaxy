/**
 * A chat turn is started through a Workflow: a step with a two-minute timeout
 * calls `startTurn` on the object that owns the conversation, and when the
 * step fails for good the Workflow calls `abandonTurn`, which fences the turn
 * id so that a start still in flight is refused. The planted object checks
 * the fence before it asks the model for the run's plan and writes the run
 * when the answer comes back, without looking again.
 */

import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface Env {
  readonly CHAT: DurableObjectNamespace<Conversation>;
  readonly SAFE_CHAT: DurableObjectNamespace<FixedConversation>;
  readonly TURNS: Workflow;
}

export type TurnParams = { readonly turnId: string; readonly fixed?: boolean };

async function plan(turnId: string): Promise<string> {
  const res = await fetch("https://model.example/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  if (!res.ok) throw new Error(`the model answered ${res.status}`);
  return ((await res.json()) as { runId: string }).runId;
}

/** The planted bug: the fence is checked before the model call and not again before the write. */
export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, fenced INTEGER NOT NULL DEFAULT 0, run_id TEXT)",
    );
  }

  async startTurn(turnId: string): Promise<{ runId: string }> {
    if (this.fenced(turnId)) throw new Error(`turn ${turnId} was abandoned`);
    // While the model answers, the object's input gate is open: another call may fence the turn.
    const runId = await plan(turnId);
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (id, fenced, run_id) VALUES (?, 0, ?) ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id",
      turnId,
      runId,
    );
    return { runId };
  }

  /** Fence the turn: no run of it may start, and one that started is cancelled. */
  async abandonTurn(turnId: string): Promise<{ fenced: true }> {
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (id, fenced, run_id) VALUES (?, 1, NULL) ON CONFLICT (id) DO UPDATE SET fenced = 1, run_id = NULL",
      turnId,
    );
    return { fenced: true };
  }

  protected fenced(turnId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ fenced: number }>("SELECT fenced FROM turns WHERE id = ?", turnId)
      .toArray();
    return row?.fenced === 1;
  }
}

/** The fix: the fence is checked again in the same synchronous block as the write. */
export class FixedConversation extends Conversation {
  override async startTurn(turnId: string): Promise<{ runId: string }> {
    if (this.fenced(turnId)) throw new Error(`turn ${turnId} was abandoned`);
    const runId = await plan(turnId);
    if (this.fenced(turnId)) throw new Error(`turn ${turnId} was abandoned`);
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (id, fenced, run_id) VALUES (?, 0, ?) ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id",
      turnId,
      runId,
    );
    return { runId };
  }
}

export class TurnFlow extends WorkflowEntrypoint<Env, TurnParams> {
  override async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep) {
    const { turnId, fixed } = event.payload;
    const chat = (fixed ? this.env.SAFE_CHAT : this.env.CHAT).getByName("c");
    try {
      return await step.do(
        "start turn",
        { retries: { limit: 0, delay: "10 seconds", backoff: "constant" }, timeout: "2 minutes" },
        async () => {
          const { runId } = await chat.startTurn(turnId);
          return { runId };
        },
      );
    } catch (err) {
      // The step failed for good: abandon the turn, so that a start still in flight is refused.
      await step.do("recover", async () => {
        await chat.abandonTurn(turnId);
        return { fenced: true };
      });
      return { abandoned: String(err) };
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/turn\/([\w-]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    const turnId = match[1] as string;
    const params: TurnParams = {
      turnId,
      ...(url.searchParams.has("fixed") ? { fixed: true } : {}),
    };
    await env.TURNS.create({ id: turnId, params });
    return new Response("accepted", { status: 202 });
  },
} satisfies ExportedHandler<Env>;
