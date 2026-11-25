/**
 * An object that resets itself: `quit` calls its own `ctx.abort()`, which
 * ends the call and drops the instance, and with it what the object held in
 * memory. The next call finds a new instance.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject<Env> {
  /** In memory only: gone with the instance. */
  private seen = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counts (id TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    );
  }

  async count(id: string): Promise<number> {
    this.seen++;
    this.ctx.storage.sql.exec(
      "INSERT INTO counts (id, n) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n",
      id,
      this.seen,
    );
    return this.seen;
  }

  /** An ordinary failure: the call fails and the instance lives on. */
  async refuse(): Promise<never> {
    throw new Error("the counter refused");
  }

  async quit(): Promise<never> {
    this.ctx.abort("the counter gave up");
    throw new Error("unreachable");
  }

  /** Answers, and resets itself a moment later: no call fails. */
  async quitLater(): Promise<string> {
    setTimeout(() => this.ctx.abort("the counter gave up later"), 10);
    return "ok";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const counter = env.COUNTER.getByName("c");
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (path === "/count") return Response.json({ n: await counter.count("a") });
    if (path === "/refuse") {
      try {
        await counter.refuse();
      } catch (err) {
        return Response.json({ refused: String(err) });
      }
    }
    if (path === "/quit") {
      try {
        await counter.quit();
      } catch (err) {
        return Response.json({ quit: String(err) });
      }
    }
    if (path === "/quit-later") return Response.json({ answered: await counter.quitLater() });
    if (path === "/quit-then-count") {
      await counter.count("a");
      try {
        await counter.quit();
      } catch {
        // The object reset itself: the call fails with the reason it gave.
      }
      // Through the same stub the next call fails too, with the reason the object gave.
      return Response.json({ n: await counter.count("a") });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
