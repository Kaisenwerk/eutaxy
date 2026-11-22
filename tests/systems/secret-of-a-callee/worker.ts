/**
 * A front Worker that hands each note to the notes Worker, which needs a
 * secret, and says which region it runs in, which it reads from a var.
 */

import type Notes from "./notes/worker.ts";

export interface Env {
  readonly NOTES: Fetcher & Notes;
  readonly REGION: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/notes\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    console.log(`front: region ${env.REGION}`);
    try {
      return Response.json(await env.NOTES.record(match[1]));
    } catch {
      return Response.json({ ok: false }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
