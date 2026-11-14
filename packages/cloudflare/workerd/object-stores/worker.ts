/**
 * An object that keeps files, with both of its stores outside itself
 * reached through its own env: the bytes go to a bucket inside the call it
 * is serving, and the catalogue row to a database in work the answer does
 * not wait for. Its constructor loads the size limit from the database
 * behind its input gate. Every write outside is one that can be made
 * twice: a put of the same bytes under the same key, and a row keyed by
 * the file's name. So whatever separates a write outside from the
 * object's own record of it, the watchdog alarm or the caller's resend
 * makes it again and nothing is counted twice.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly LIBRARY: DurableObjectNamespace<Library>;
  readonly DB: D1Database;
  readonly BUCKET: R2Bucket;
}

const watchdogMs = 30_000;

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
    // The bytes first: a catalogue row never names a file that is not there.
    await this.env.BUCKET.put(name, text);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO files (name, status, size) VALUES (?, 'stored', ?)",
      name,
      text.length,
    );
    await this.ctx.storage.setAlarm(Date.now() + watchdogMs);
    // The work the answer does not wait for; what it leaves stored is the watchdog's.
    void this.list(name).catch(() => {});
    return { stored: true };
  }

  /** The watchdog: whatever is stored and not yet in the catalogue is listed again. */
  override async alarm(): Promise<void> {
    const stored = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM files WHERE status = 'stored'")
      .toArray();
    for (const { name } of stored) await this.list(name);
  }

  private async list(name: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [file] = this.ctx.storage.sql
      .exec<{ size: number }>("SELECT size FROM files WHERE name = ?", name)
      .toArray();
    if (!file) return;
    // Keyed by the file's name: listing a file twice is listing it once.
    await this.env.DB.prepare("INSERT OR IGNORE INTO catalogue (name, size) VALUES (?1, ?2)")
      .bind(name, file.size)
      .run();
    this.ctx.storage.sql.exec("UPDATE files SET status = 'listed' WHERE name = ?", name);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.split("/")[2] ?? "";
    const library = env.LIBRARY.get(env.LIBRARY.idFromName("lib"));
    const { stored } = await library.add(name, await request.text());
    return new Response(null, { status: stored ? 201 : 413 });
  },
} satisfies ExportedHandler<Env>;
