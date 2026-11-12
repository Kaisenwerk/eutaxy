/**
 * An object that keeps files in two stores outside itself, both reached
 * through its own env: the bytes go to a bucket inside the call it is
 * serving, and the catalogue row to a database in work the answer does
 * not wait for. Its constructor loads the size limit from the database
 * behind its input gate, and `read` gets a file's bytes back from the
 * bucket and its row from the database. The work after the answer starts
 * at once, with no timer, so the raw run, where nothing drives the
 * object's timers, finishes it too.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly LIBRARY: DurableObjectNamespace<Library>;
  readonly DB: D1Database;
  readonly BUCKET: R2Bucket;
}

export class Library extends DurableObject<Env> {
  /** The largest file taken, in bytes: the database's setting, read as the object comes up. */
  private maxBytes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, status TEXT NOT NULL, size INTEGER NOT NULL)",
    );
    void this.ctx.blockConcurrencyWhile(async () => {
      const setting = await this.env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
        .bind("max_bytes")
        .first<{ value: number }>();
      this.maxBytes = setting?.value ?? 0;
    });
  }

  async add(name: string, text: string): Promise<{ stored: boolean }> {
    if (text.length > this.maxBytes) return { stored: false };
    await this.env.BUCKET.put(name, text, { customMetadata: { by: "library" } });
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO files (name, status, size) VALUES (?, 'stored', ?)",
      name,
      text.length,
    );
    void this.list(name, text.length).catch(() => {});
    return { stored: true };
  }

  async read(name: string): Promise<{ text: string; size: number } | null> {
    const [object, row] = [
      await this.env.BUCKET.get(name),
      await this.env.DB.prepare("SELECT size FROM catalogue WHERE name = ?1")
        .bind(name)
        .first<{ size: number }>(),
    ];
    return object && row ? { text: await object.text(), size: row.size } : null;
  }

  private async list(name: string, size: number): Promise<void> {
    const db = this.env.DB;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO catalogue (name, size) VALUES (?1, ?2)").bind(name, size),
      db.prepare("UPDATE settings SET value = value WHERE key = 'max_bytes'"),
    ]);
    this.ctx.storage.sql.exec("UPDATE files SET status = 'listed' WHERE name = ?", name);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.split("/")[2] ?? "";
    const library = env.LIBRARY.get(env.LIBRARY.idFromName("lib"));
    if (request.method === "GET") {
      const file = await library.read(name);
      return file ? Response.json(file) : new Response(null, { status: 404 });
    }
    const { stored } = await library.add(name, await request.text());
    return new Response(null, { status: stored ? 201 : 413 });
  },
} satisfies ExportedHandler<Env>;
