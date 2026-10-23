/**
 * A chat-platform webhook that applies each event under a short per-
 * subscription lease in D1 and answers 503 while another handler holds it,
 * relying on the platform to resend later.
 *
 * Planted bug: the lease lives 24 hours, longer than the platform's whole
 * resend window (15 s, 5 min, 1 h, 6 h). A crash after taking the lease
 * leaves it held, every resend gets 503, and the event is never applied.
 * With a lease shorter than the resend window a later resend finds it
 * expired and applies the event.
 */

export interface Env {
  readonly DB: D1Database;
}

export interface ChatEvent {
  readonly eventId: string;
  readonly subscription: string;
}

export const plantedLeaseMs = 24 * 60 * 60 * 1000;

/** The handler, with the lease's lifetime as a parameter. */
export function chatWebhook(leaseMs: number): ExportedHandler<Env> {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/webhooks/chat") {
        return new Response("not found", { status: 404 });
      }
      const event = (await request.json()) as ChatEvent;
      const now = Date.now();
      // Take the lease, or take it over once it has expired.
      const taken = await env.DB.prepare(
        "INSERT INTO leases (subscription, until) VALUES (?1, ?2) ON CONFLICT (subscription) DO UPDATE SET until = excluded.until WHERE leases.until <= ?3",
      )
        .bind(event.subscription, now + leaseMs, now)
        .run();
      if (taken.meta.changes === 0) return new Response("busy", { status: 503 });
      await env.DB.prepare("INSERT OR IGNORE INTO applied_events (event_id) VALUES (?1)")
        .bind(event.eventId)
        .run();
      await env.DB.prepare("DELETE FROM leases WHERE subscription = ?1")
        .bind(event.subscription)
        .run();
      return Response.json({ applied: event.eventId });
    },
  };
}

export default chatWebhook(plantedLeaseMs);
