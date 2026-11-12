/**
 * The front Worker: a request starts a Workflow, which asks the turns Worker
 * to run a turn and then waits to be told the turn has ended. The turns
 * Worker tells it by calling back into this Worker (`Notices.turnEnded`),
 * which sends the event the Workflow waits for. Should the notice not come
 * within a minute, the Workflow asks for the reply itself. Either way one
 * reply per request is delivered, and the table says which way it came.
 */

import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

/** The turns Worker's entrypoint, as this Worker calls it. */
export interface Turns {
  startTurn(id: string): Promise<{ accepted: true }>;
  replyOf(id: string): Promise<string | null>;
}

export interface Env {
  readonly DB: D1Database;
  readonly REQUESTS: Workflow<{ id: string }>;
  readonly TURNS: Fetcher & Turns;
}

export class RequestFlow extends WorkflowEntrypoint<Env, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void> {
    const { id } = event.payload;
    await step.do("start turn", async () => {
      await this.env.TURNS.startTurn(id);
      return null;
    });
    let reply: { text: string; via: string };
    try {
      const ended = await step.waitForEvent<{ reply: string }>("turn ended", {
        type: "turn-ended",
        timeout: "1 minute",
      });
      reply = { text: ended.payload.reply, via: "event" };
    } catch {
      // The notice did not come: ask for the reply.
      const text = await step.do("poll", async () => (await this.env.TURNS.replyOf(id)) ?? "");
      reply = { text, via: "poll" };
    }
    await step.do("deliver", async () => {
      await this.env.DB.prepare(
        "INSERT OR REPLACE INTO replies (request_id, reply, via) VALUES (?1, ?2, ?3)",
      )
        .bind(id, reply.text, reply.via)
        .run();
      return null;
    });
  }
}

/**
 * What the turns Worker calls back: a turn has ended, with its reply. The
 * turns Worker sends a notice again when it got no answer for it, so the
 * same notice may arrive twice: it is recorded once, by a statement that
 * inserts only what is not there.
 */
export class Notices extends WorkerEntrypoint<Env> {
  async turnEnded(id: string, reply: string): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO notices (request_id, reply) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM notices WHERE request_id = ?1)",
    )
      .bind(id, reply)
      .run();
    await wake(this.env, id, reply);
  }
}

/** Wake the request's Workflow with the reply; a second event for one wait is kept and never read. */
export async function wake(env: Env, id: string, reply: string): Promise<void> {
  const instance = await env.REQUESTS.get(id);
  await instance.sendEvent({ type: "turn-ended", payload: { reply } });
}

export default class Front extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    await this.env.REQUESTS.create({ id, params: { id } });
    return Response.json({ accepted: id }, { status: 202 });
  }
}
