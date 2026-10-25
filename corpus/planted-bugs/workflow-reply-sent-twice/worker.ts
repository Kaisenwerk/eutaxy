/**
 * A chat webhook stores nothing itself: it starts one Workflow instance per
 * message, keyed by the message id, and answers at once. The Workflow
 * generates a reply with a model API, then posts it to the chat API.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Env = { readonly TURNS: Workflow; readonly COUNTING: Workflow };
type Turn = { readonly messageId: string; readonly text: string };

async function generate(text: string): Promise<string> {
  const r = await fetch("https://model.example/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: text }),
  });
  return ((await r.json()) as { reply: string }).reply;
}

/** The planted bug: the reply carries no idempotency key, so a step that runs again posts again. */
export class ChatTurn extends WorkflowEntrypoint<Env, Turn> {
  override async run(event: WorkflowEvent<Turn>, step: WorkflowStep) {
    const reply = await step.do("generate", () => generate(event.payload.text));
    return step.do("post reply", async () => {
      const r = await fetch(`https://chat.example/messages/${event.payload.messageId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: event.payload.messageId, text: reply }),
      });
      return r.status;
    });
  }
}

/** The fix: the message id is the reply's idempotency key, which the chat API deduplicates by. */
export class FixedChatTurn extends WorkflowEntrypoint<Env, Turn> {
  override async run(event: WorkflowEvent<Turn>, step: WorkflowStep) {
    const reply = await step.do("generate", () => generate(event.payload.text));
    return step.do("post reply", async () => {
      const r = await fetch(`https://chat.example/messages/${event.payload.messageId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": event.payload.messageId },
        body: JSON.stringify({ messageId: event.payload.messageId, text: reply }),
      });
      return r.status;
    });
  }
}

/**
 * No network, for checking the model against the local engine: a step
 * repeated by name, a step that fails its first attempt, and a sleep.
 */
export class CountingFlow extends WorkflowEntrypoint<Env, { n: number }> {
  override async run(event: WorkflowEvent<{ n: number }>, step: WorkflowStep) {
    const counts: number[] = [];
    for (let i = 0; i < event.payload.n; i++)
      counts.push(await step.do("tick", async (ctx) => ctx.step.count));
    const attempt = await step.do(
      "flaky",
      { retries: { limit: 2, delay: "1 second", backoff: "constant" } },
      async (ctx) => {
        if (ctx.attempt < 2) throw new Error("first attempt fails");
        return ctx.attempt;
      },
    );
    await step.sleep("pause", "1 minute");
    return { counts, attempt, id: event.instanceId, payload: event.payload };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/counting") {
      await env.COUNTING.create({ id: "count-1", params: { n: 3 } });
      return new Response("started");
    }
    const turn = (await request.json()) as Turn;
    try {
      await env.TURNS.create({ id: turn.messageId, params: turn });
    } catch (err) {
      // A resent webhook: the instance for this message exists already.
      if (!String(err).includes("instance.already_exists")) throw err;
    }
    return new Response("accepted", { status: 202 });
  },
};
