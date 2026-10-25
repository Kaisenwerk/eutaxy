/**
 * An attachment upload: stores the file in R2 under a fresh key, then
 * records it in D1 and answers 201.
 *
 * Planted bug: the object is written before the row that names it. A crash
 * or a failed insert in between leaves an object no row names, and the
 * client's retry uploads under another fresh key, so the first object is
 * never cleaned up: storage that is paid for and holds user data nobody
 * can see or delete.
 */

export interface Env {
  readonly FILES: R2Bucket;
  readonly DB: D1Database;
}

export interface Upload {
  readonly messageId: string;
  readonly name: string;
  readonly text: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/attachments") {
      return new Response("not found", { status: 404 });
    }
    const upload = (await request.json()) as Upload;
    const key = `attachments/${crypto.randomUUID()}`;
    await env.FILES.put(key, upload.text, { customMetadata: { name: upload.name } });
    await env.DB.prepare(
      "INSERT INTO attachments (message_id, name, object_key) VALUES (?1, ?2, ?3)",
    )
      .bind(upload.messageId, upload.name, key)
      .run();
    return Response.json({ key }, { status: 201 });
  },
} satisfies ExportedHandler<Env>;
