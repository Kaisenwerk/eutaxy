/**
 * A Worker on its own, with no service binding: it reads a var, and its
 * Durable Object reads a secret off the env the runtime constructs it with.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly KEEPER: DurableObjectNamespace<Keeper>;
  readonly REGION?: string;
  readonly API_KEY?: string;
}

export class Keeper extends DurableObject<Env> {
  async tell(id: string): Promise<{ ok: boolean }> {
    const key = this.env.API_KEY;
    console.log(
      key === undefined
        ? `object: no key for ${id}`
        : `object: ${id} kept with a key of ${key.length} characters`,
    );
    return { ok: key !== undefined };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/keep\/([\w-]+)$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match?.[1]) return new Response("not found", { status: 404 });
    console.log(`solo: region ${env.REGION ?? "unset"}`);
    return Response.json(await env.KEEPER.getByName("k").tell(match[1]));
  },
} satisfies ExportedHandler<Env>;
