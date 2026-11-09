/**
 * The gate's Workflow starts a turn on an object in a step with a timeout
 * and, when the step fails for good, abandons the turn. The object fences an
 * abandoned turn so that a start still in flight is refused: it checks the
 * fence before it asks the model and again, in the same synchronous block
 * as its write, after the answer came back, since the fence may have been
 * set while it waited. A start may be asked to nap first, on a timer of its
 * own, so that the call outlives the step's timeout.
 */

import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface Env {
  readonly CHAT: DurableObjectNamespace<Conversation>;
  readonly TURNS: Workflow;
}

export type TurnParams = { readonly turnId: string; readonly napMs: number };

export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, fenced INTEGER NOT NULL DEFAULT 0, run_id TEXT)",
    );
  }

  /** Start the turn's run unless the turn was abandoned; refused with an error if it was. */
  async startTurn(turnId: string, napMs: number): Promise<{ runId: string }> {
    if (this.fenced(turnId)) throw new Error(`turn ${turnId} was abandoned`);
    if (napMs > 0) await new Promise((resolve) => setTimeout(resolve, napMs));
    const res = await fetch("https://model.example/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    });
    if (!res.ok) throw new Error(`the model answered ${res.status}`);
    const { runId } = (await res.json()) as { runId: string };
    // The fence may have been set while the model answered: checked again with the write, with no
    // await between them, so no other call gets in between.
    if (this.fenced(turnId)) throw new Error(`turn ${turnId} was abandoned`);
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

  /** The turn's row, for the flow's final confirmation. */
  async turnStatus(turnId: string): Promise<{ fenced: boolean; runId: string | null }> {
    const [row] = this.ctx.storage.sql
      .exec<{ fenced: number; run_id: string | null }>(
        "SELECT fenced, run_id FROM turns WHERE id = ?",
        turnId,
      )
      .toArray();
    return { fenced: row?.fenced === 1, runId: row?.run_id ?? null };
  }

  private fenced(turnId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ fenced: number }>("SELECT fenced FROM turns WHERE id = ?", turnId)
      .toArray();
    return row?.fenced === 1;
  }
}

export class TurnFlow extends WorkflowEntrypoint<Env, TurnParams> {
  override async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep) {
    const { turnId, napMs } = event.payload;
    const chat = this.env.CHAT.getByName("c");
    let started: { runId: string } | { abandoned: string };
    try {
      started = await step.do(
        "start turn",
        { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "2 minutes" },
        async () => {
          const { runId } = await chat.startTurn(turnId, napMs);
          return { runId };
        },
      );
    } catch (err) {
      // The step failed for good: the turn is abandoned, whatever a start still in flight does.
      await step.do("recover", async () => {
        await chat.abandonTurn(turnId);
        return { fenced: true };
      });
      started = { abandoned: String(err) };
    }
    // Once any start still in flight has had time to end, confirm what the object holds.
    await step.sleep("settle", "10 minutes");
    const status = await step.do("confirm", async () => {
      const { fenced, runId } = await chat.turnStatus(turnId);
      return { fenced, runId };
    });
    return { ...started, status };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/turn\/([\w-]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    const turnId = match[1] as string;
    const napMs = Number(url.searchParams.get("nap") ?? 0);
    await env.TURNS.create({ id: turnId, params: { turnId, napMs } satisfies TurnParams });
    return new Response("accepted", { status: 202 });
  },
} satisfies ExportedHandler<Env>;
