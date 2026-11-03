/**
 * A chat room kept by an Agent (Cloudflare Agents SDK) over WebSocket
 * connections: each message is checked by an external moderation API, then
 * counted in the Agent's state and its own table, and the count is broadcast
 * to every connection.
 *
 * Planted bug: a message reads the count, awaits the moderation call, then
 * writes the count plus one. The Agent is a Durable Object, whose input
 * gate is open while it awaits an outbound fetch, so messages from two
 * connections at once both read 0 and both write 1: a lost update, so two
 * messages take the same count and every client is told the room holds one
 * message where two arrived. The fix writes the state before the await.
 */

import { Agent, type Connection, routeAgentRequest, type WSMessage } from "agents";

export interface Env {
  readonly ROOM: DurableObjectNamespace<Room>;
}

export interface RoomState {
  readonly messages: number;
}

export class Room extends Agent<Env, RoomState> {
  override initialState: RoomState = { messages: 0 };

  override async onMessage(_connection: Connection, message: WSMessage): Promise<void> {
    const count = this.state.messages;
    await this.moderate(String(message));
    this.setState({ messages: count + 1 });
    this.counted(count + 1);
    this.broadcast(JSON.stringify({ type: "count", count: count + 1 }));
  }

  /** Each message's count, in the Agent's own table: two messages never share one. */
  protected counted(n: number): void {
    this.sql`CREATE TABLE IF NOT EXISTS counts (n INTEGER NOT NULL)`;
    this.sql`INSERT INTO counts (n) VALUES (${n})`;
  }

  protected async moderate(text: string): Promise<void> {
    const res = await fetch("https://moderation.example/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`moderation failed with ${res.status}`);
  }
}

/** The fix: the count is taken before the outbound call, so a concurrent message reads it. */
export class FixedRoom extends Room {
  override async onMessage(_connection: Connection, message: WSMessage): Promise<void> {
    const count = this.state.messages + 1;
    this.setState({ messages: count });
    this.counted(count);
    await this.moderate(String(message));
    this.broadcast(JSON.stringify({ type: "count", count }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
