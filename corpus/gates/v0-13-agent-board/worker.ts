/**
 * A shared board kept by an Agent (Cloudflare Agents SDK), the way the
 * phase's target writes its objects: clients connect over WebSockets and
 * post items; each item is checked by an external API, kept in the Agent's
 * own table and counted in its state, and every client is told the new
 * count. The first item schedules a digest, which the Agent writes from
 * its table when its schedule fires over the object's alarm. The Worker
 * reaches the Agent through the SDK's router.
 */

import { Agent, type Connection, routeAgentRequest, type WSMessage } from "agents";

export interface Env {
  readonly BOARD: DurableObjectNamespace<Board>;
}

export interface BoardState {
  readonly items: number;
  readonly digested: boolean;
}

export class Board extends Agent<Env, BoardState> {
  override initialState: BoardState = { items: 0, digested: false };

  override async onConnect(connection: Connection): Promise<void> {
    connection.send(JSON.stringify({ type: "welcome", items: this.state.items }));
  }

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    const { id, text } = JSON.parse(String(message)) as { id: string; text: string };
    this.sql`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS digests (items INTEGER NOT NULL)`;
    // Taken before the outbound call, so a concurrent post reads it.
    const items = this.state.items + 1;
    this.setState({ ...this.state, items });
    this.sql`INSERT OR IGNORE INTO items (id, text) VALUES (${id}, ${text})`;
    if (items === 1) await this.schedule(30, "digest");
    await this.screen(text);
    connection.send(JSON.stringify({ type: "posted", id }));
    this.broadcast(JSON.stringify({ type: "count", items }));
  }

  /** The scheduled callback: the board's size from its own table, into the digests. */
  async digest(): Promise<void> {
    const [row] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM items`;
    this.sql`INSERT INTO digests (items) VALUES (${row?.n ?? 0})`;
    this.setState({ ...this.state, digested: true });
  }

  protected async screen(text: string): Promise<void> {
    const res = await fetch("https://screening.example/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`screening failed with ${res.status}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
