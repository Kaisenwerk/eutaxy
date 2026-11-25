/**
 * A room over WebSocket connections, on the Hibernation API as a Durable
 * Object is written for it: each connection is accepted with a tag (the
 * client's name, from the query) and an attachment, every message is
 * counted in storage and echoed back with its number, `bye` closes the
 * connection from the server side, a client named `nobody` is turned away
 * before the upgrade is answered, and a close is counted too. `PingRoom`
 * answers pings on the runtime's auto-response, which Eutaxy refuses.
 * `SlowRoom` takes its time over a close before it counts it.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly ROOM: DurableObjectNamespace<Room>;
  readonly PING_ROOM: DurableObjectNamespace<PingRoom>;
  readonly SLOW_ROOM: DurableObjectNamespace<SlowRoom>;
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

/** A room that counts a close only some real time after it was told of it: after the run's snapshot, that is after the run. */
export class SlowRoom extends Room {
  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await super.webSocketClose(ws, code);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, kind, room] = url.pathname.split("/");
    const namespace =
      kind === "rooms"
        ? env.ROOM
        : kind === "ping-rooms"
          ? env.PING_ROOM
          : kind === "slow-rooms"
            ? env.SLOW_ROOM
            : undefined;
    if (!namespace || !room) return new Response("not found", { status: 404 });
    return namespace.get(namespace.idFromName(room)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
