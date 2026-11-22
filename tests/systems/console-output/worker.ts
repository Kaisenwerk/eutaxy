/**
 * A front Worker that hands each note to the notes Worker and answers what
 * it was told. Both write to the console: what a developer reads to learn
 * why a call was refused.
 */

import type Notes from "./notes/worker.ts";

export interface Env {
  readonly NOTES: Fetcher & Notes;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/notes\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    const id = match[1];
    const text = await request.text();
    console.log(`front: note ${id} received`);
    const { ok } = await env.NOTES.record(id, text);
    if (!ok) console.error(`front: note ${id} was refused`);
    return Response.json({ ok }, { status: ok ? 200 : 422 });
  },
} satisfies ExportedHandler<Env>;
