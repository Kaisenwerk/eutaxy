/**
 * An approval flow: a request starts a Workflow instance for a document, a
 * later request delivers the approver's decision as an event, and the
 * Workflow notifies the requester once the decision is in.
 *
 * Planted bug: the notification is sent outside a step. The engine replays
 * `run()` from the start after a restart, with the wait's event stored, so
 * a crash after the notification left makes the replay send it again.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Env = { readonly APPROVALS: Workflow };
type Params = { readonly documentId: string };
type Decision = { readonly by: string; readonly approved: boolean };

async function notify(
  documentId: string,
  decision: Decision,
  headers: Record<string, string> = {},
): Promise<number> {
  const r = await fetch("https://notify.example/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ documentId, ...decision }),
  });
  return r.status;
}

/** The planted bug: the notification is not a step, so a restart after it sends it again; and it carries no key. */
export class ApprovalFlow extends WorkflowEntrypoint<Env, Params> {
  override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const decision = await step.waitForEvent<Decision>("decision", {
      type: "decided",
      timeout: "7 days",
    });
    const status = await notify(event.payload.documentId, decision.payload);
    return { documentId: event.payload.documentId, by: decision.payload.by, status };
  }
}

/**
 * The fix: the notification is a step, persisted once it ran, and it carries
 * the document id as its idempotency key, which the notification service
 * deduplicates by, so a retry of the step after a lost answer is harmless.
 */
export class FixedApprovalFlow extends WorkflowEntrypoint<Env, Params> {
  override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const decision = await step.waitForEvent<Decision>("decision", {
      type: "decided",
      timeout: "7 days",
    });
    const status = await step.do("notify", () =>
      notify(event.payload.documentId, decision.payload, {
        "idempotency-key": event.payload.documentId,
      }),
    );
    return { documentId: event.payload.documentId, by: decision.payload.by, status };
  }
}

/** No network, for checking the model against the local engine: waits, then reports what it got. */
export class EchoFlow extends WorkflowEntrypoint<Env, Params> {
  override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const first = await step.waitForEvent<Decision>("first", { type: "decided" });
    const second = await step.waitForEvent<{ note: string }>("second", { type: "noted" });
    return {
      documentId: event.payload.documentId,
      by: first.payload.by,
      note: second.payload.note,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as { documentId: string; by?: string; approved?: boolean };
    if (url.pathname === "/approvals") {
      await env.APPROVALS.create({ id: body.documentId, params: { documentId: body.documentId } });
      return Response.json({ started: body.documentId });
    }
    if (url.pathname === "/decisions") {
      const instance = await env.APPROVALS.get(body.documentId);
      await instance.sendEvent({
        type: "decided",
        payload: { by: body.by, approved: body.approved },
      });
      return Response.json({ delivered: body.documentId });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
