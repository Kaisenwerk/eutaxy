/**
 * A sign-in endpoint: emails a one-time code, at most one per address per
 * minute.
 *
 * Planted bug: the limit is a read followed by an insert. One request at a
 * time it holds: the second request sees the first code and gets 429. Two
 * requests in flight at once (a double click, two tabs) both read before
 * either inserts, and both send a code.
 */

export interface Env {
  readonly DB: D1Database;
}

const windowMs = 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sign-in/code") {
      return new Response("not found", { status: 404 });
    }
    const { email } = (await request.json()) as { email: string };
    const now = Date.now();
    const recent = await env.DB.prepare(
      "SELECT 1 AS hit FROM code_sends WHERE email = ?1 AND sent_at > ?2",
    )
      .bind(email, now - windowMs)
      .first();
    if (recent) return new Response("try again in a minute", { status: 429 });
    const code = String((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000).padStart(
      6,
      "0",
    );
    await env.DB.prepare("INSERT INTO code_sends (email, code, sent_at) VALUES (?1, ?2, ?3)")
      .bind(email, code, now)
      .run();
    return Response.json({ sent: true });
  },
} satisfies ExportedHandler<Env>;
