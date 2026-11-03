/**
 * A room over WebSocket connections, on the Hibernation API as a Durable
 * Object is written for it: each connection is accepted with a tag (the
 * client's name, from the query) and an attachment, every message is
 * counted in storage and echoed back with its number, `bye` closes the
 * connection from the server side, a client named `nobody` is turned away
 * before the upgrade is answered, and a close is counted too. `PingRoom`
 * answers pings on the runtime's auto-response, which Eutaxy refuses.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly ROOM: DurableObjectNamespace<Room>;
  readonly PING_ROOM: DurableObjectNamespace<PingRoom>;
}

export class Room extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected a WebSocket", { status: 426 });
    const name = new URL(request.url).searchParams.get("name") ?? "anonymous";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [name]);
    pair[1].serializeAttachment({ name });
    if (name === "nobody") pair[1].close(4001, "not welcome");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = String(message);
    if (text === "bye") {
      ws.close(1000, "goodbye");
      return;
    }
    const n = ((await this.ctx.storage.get<number>("messages")) ?? 0) + 1;
    await this.ctx.storage.put("messages", n);
    const { name } = ws.deserializeAttachment() as { name: string };
    ws.send(JSON.stringify({ n, name, text }));
  }

  override async webSocketClose(_ws: WebSocket, code: number): Promise<void> {
    const n = ((await this.ctx.storage.get<number>("closes")) ?? 0) + 1;
    await this.ctx.storage.put("closes", n);
    await this.ctx.storage.put(`close-${n}`, code);
  }
}

/** A room whose pings the runtime answers without waking it: not modelled, so Eutaxy refuses it. */
export class PingRoom extends Room {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, kind, room] = url.pathname.split("/");
    const namespace =
      kind === "rooms" ? env.ROOM : kind === "ping-rooms" ? env.PING_ROOM : undefined;
    if (!namespace || !room) return new Response("not found", { status: 404 });
    return namespace.get(namespace.idFromName(room)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
