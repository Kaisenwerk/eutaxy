/**
 * WebSocket connections as events. The scenario opens a connection with an
 * upgrade request through the Worker's fetch handler, as a client would;
 * the Worker hands it to a Durable Object (the Agents SDK's router does),
 * whose fetch answers 101, and Eutaxy keeps the client end. Each message is
 * then one event delivered inside the object, by calling its
 * `webSocketMessage` handler (the Hibernation API; the Agents SDK uses it)
 * on the server end of that connection, as an alarm is delivered by calling
 * `alarm()`, with the faults an alarm has: `crash_before` (the object
 * crashed before handling it), `crash_after` (handled, then crashed) and
 * `error` (the handler threw). A crash drops the instance, rebuilt within
 * the same delivery since no retry follows a message; the runtime keeps
 * a hibernatable connection, as it does across hibernation, and the next
 * instance sees it under a new `WebSocket` identity with its attachment and
 * tags, so before each message the connection's server end is found again
 * in the live object: by identity, else by attachment and tags (the object
 * must give them to tell its connections apart; otherwise the run is
 * `UNSUPPORTED`). A message is an event of its own, so the scheduler
 * interleaves connections; it waits for its connection to be open and for
 * the message before it on that connection. One the object closed is
 * recorded as not delivered. What the object sends back arrives on the
 * client end; the frames are kept per connection in arrival order and
 * recorded at the end of the run as effects (`WebSocket:<connection>`, op
 * `message`, under the platform's own invocation), since when a frame
 * crosses the pair depends on the event loop, not on the schedule, and a
 * trace must repeat. A close the object makes during the run is recorded
 * too (op `close`). After the run's snapshot the connections still open are
 * torn down outside the run: what the objects' `webSocketClose` handlers
 * do then is not modelled (a request made then makes the run UNSUPPORTED).
 */

import {
  canonicalJson,
  type DeliveryResult,
  type EventRef,
  invocationOf,
  type JsonValue,
  type RunHooks,
  readFaults,
  type ScenarioSpec,
  toJson,
} from "@eutaxy/core";
import { note, realTick, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import { requestOrigin } from "./http.ts";
import { hostedInObject, hostOf, type ObjectAccess } from "./object-access.ts";
import type { WebSocketConnectionSpec, WebSocketDrive, WebSocketEventData } from "./scenario.ts";

/** The object a connection reached, as the stub proxy saw its 101: the invocation whose stub call it was, and the client end. */
export interface UpgradeInfo {
  readonly binding: string;
  readonly id: string;
  readonly object: string;
  readonly invocation: string;
  readonly client: WebSocket;
}

/**
 * Drop a client end nobody will use, so the object sees the connection close
 * (as it does when a Worker dies holding one). An end must be accepted before
 * it can be closed; one left unaccepted stays in the object for ever and
 * keeps its instance from being evicted.
 */
function dropEnd(ws: WebSocket, reason: string): void {
  try {
    ws.accept();
  } catch {
    // accepted already
  }
  try {
    ws.close(1011, reason);
  } catch {
    // closed already
  }
}

/** How the object closed a connection (its handler called `close`), as the client end saw it. */
export interface Closed {
  readonly code: number;
  readonly reason: string;
}

interface Connection {
  readonly spec: WebSocketConnectionSpec;
  readonly client: WebSocket;
  /** The server end as the object last saw it; a dropped instance leaves a new identity behind. None when the object closed the connection before answering the upgrade. */
  server: WebSocket | undefined;
  /** The tags and the attachment the object gave the server end, as last seen; both survive the instance. */
  identity: Identity;
  readonly upgrade: UpgradeInfo;
  closed: Closed | undefined;
}

/** A promise settled from outside, for one connection's open and for each message's turn. */
class Gate {
  readonly promise: Promise<void>;
  resolve: () => void = () => {};
  constructor() {
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
  }
}

/** What identifies a server end across instances: its tags (fixed at accept) and its attachment (the object may change it). */
interface Identity {
  readonly tags: string;
  readonly attachment: string;
}

function identityOf(ws: WebSocket, live: DurableObjectState): Identity {
  let attachment: JsonValue;
  try {
    attachment = toJson(ws.deserializeAttachment());
  } catch {
    attachment = "<unreadable>";
  }
  let tags: string[] = [];
  try {
    tags = live.getTags(ws);
  } catch {
    // not accepted with the Hibernation API: no tags
  }
  return { tags: canonicalJson(tags), attachment: canonicalJson(attachment) };
}

/** Turns of the event loop the teardown waits for the objects to let their connections go. */
const closeTurns = 20;

/** The run's connections; the platform clears it before each run, closing what is still open. */
export class Connections {
  readonly open = new Map<string, Connection>();
  /** Per connection: settled once its open was delivered, whatever came of it. */
  readonly opened = new Map<string, Gate>();
  /** Per connection and message index: settled once that message was delivered. */
  readonly delivered = new Map<string, Gate>();
  /** The frames each connection received this run, in arrival order, until the end of the run records them. */
  readonly frames = new Map<string, JsonValue[]>();
  /** Every 101 a stub fetch answered this run, as the proxy saw it; an open claims its own, the rest are dropped. */
  readonly upgrades: { readonly info: UpgradeInfo; claimed: boolean }[] = [];

  gate(map: Map<string, Gate>, key: string): Gate {
    let g = map.get(key);
    if (!g) {
      g = new Gate();
      map.set(key, g);
    }
    return g;
  }

  /** Resolves once the connection's open was delivered (it may have failed: `open` then lacks it). */
  openedOf(connection: string): Promise<void> {
    return this.gate(this.opened, connection).promise;
  }

  /** Resolves once message `index` of the connection was delivered; index -1 is at once. */
  deliveredOf(connection: string, index: number): Promise<void> {
    return index < 0
      ? Promise.resolve()
      : this.gate(this.delivered, `${connection}:${index}`).promise;
  }

  /** Closes that reached a client end before its connection was registered: the object closed it while answering the upgrade. */
  readonly earlyClosed = new Map<string, Closed>();
  /** Counts the runs, so what a client end of an earlier run reports after its teardown is ignored. */
  generation = 0;

  received(generation: number, connection: string, data: JsonValue): void {
    if (generation !== this.generation) return;
    const list = this.frames.get(connection);
    if (list) list.push(data);
    else this.frames.set(connection, [data]);
  }

  /** The client end saw a close during the run: the object closed the connection. */
  closedBy(generation: number, connection: string, code: number, reason: string): void {
    if (generation !== this.generation) return;
    const c = this.open.get(connection);
    if (c) {
      if (!c.closed) c.closed = { code, reason };
    } else if (!this.earlyClosed.has(connection))
      this.earlyClosed.set(connection, { code, reason });
  }

  upgradedTo(info: UpgradeInfo): void {
    this.upgrades.push({ info, claimed: false });
  }

  /** The object this open reached: a stub fetch of its own invocation answered 101 during it. Claimed once. */
  upgraded(invocation: string): UpgradeInfo | undefined {
    const u = this.upgrades.find((x) => !x.claimed && x.info.invocation === invocation);
    if (u) u.claimed = true;
    return u?.info;
  }

  /** Drop the client ends no open claimed: an open that crashed after the object accepted, or an upgrade made elsewhere. */
  dropUnclaimed(reason: string): boolean {
    let dropped = false;
    for (const u of this.upgrades) {
      if (u.claimed) continue;
      u.claimed = true;
      dropEnd(u.info.client, reason);
      dropped = true;
    }
    return dropped;
  }

  /**
   * Inside an object: bind its open connections to the sockets it holds now.
   * A connection whose server end is still there keeps it; one whose instance
   * was dropped since finds it again by its tags, or by tags and attachment
   * when the tags alone do not single it out. What comes back:
   * the sockets no connection holds (a new one during an open), and the
   * connections that could not be told apart.
   */
  rebind(
    upgrade: Pick<UpgradeInfo, "binding" | "id">,
    live: DurableObjectState,
  ): { readonly unbound: readonly WebSocket[]; readonly lost: readonly Connection[] } {
    const free = new Set(live.getWebSockets());
    const stale: Connection[] = [];
    for (const c of this.open.values()) {
      if (c.upgrade.binding !== upgrade.binding || c.upgrade.id !== upgrade.id || c.closed)
        continue;
      if (c.server && free.has(c.server)) {
        free.delete(c.server);
        // The object may have rewritten the attachment since: what identifies the end is what it holds now.
        c.identity = identityOf(c.server, live);
      } else stale.push(c);
    }
    const lost: Connection[] = [];
    const identities = new Map([...free].map((ws) => [ws, identityOf(ws, live)] as const));
    const single = (ok: (i: Identity) => boolean): WebSocket | undefined => {
      const matches = [...free].filter((ws) => ok(identities.get(ws) as Identity));
      return matches.length === 1 ? matches[0] : undefined;
    };
    for (const c of stale) {
      const ws =
        single((i) => i.tags === c.identity.tags) ??
        single((i) => i.tags === c.identity.tags && i.attachment === c.identity.attachment);
      if (ws) {
        c.server = ws;
        free.delete(ws);
      } else lost.push(c);
    }
    return { unbound: [...free], lost };
  }

  /**
   * After the run's snapshot: close what is still open and wait until each
   * object has let its connections go, so nothing survives into the next run
   * (a hibernatable socket outlives eviction and `deleteAll`). The objects'
   * `webSocketClose` handlers run meanwhile, outside the run: nothing they
   * do is observed. Returns why, when an object still holds a socket.
   */
  async teardown(objects: ObjectAccess): Promise<string | undefined> {
    this.dropUnclaimed("the Worker died holding this connection");
    const reached = new Map<string, UpgradeInfo>();
    for (const c of this.open.values()) {
      reached.set(`${c.upgrade.binding}/${c.upgrade.id}`, c.upgrade);
      if (c.closed) continue;
      try {
        c.client.close(1000, "run over");
      } catch {
        // the other side closed first; its close reaches the client end on its way
      }
    }
    for (const u of reached.values()) {
      let left = 0;
      for (let turn = 0; turn < closeTurns; turn++) {
        left =
          (await objects.run(
            u.binding,
            u.id,
            u.object,
            async (_i, live) => live.getWebSockets().length,
          )) ?? 0;
        if (left === 0) break;
        await realTick();
      }
      if (left !== 0)
        return `WebSocket connections of ${u.object} were still open ${closeTurns} turns of the event loop after the run closed them`;
    }
    return undefined;
  }

  /** Record every connection's frames (connection order, then arrival order) and the close the object made, if any; forget the frames. */
  record(hooks: RunHooks): void {
    const bookkeeping = () => hooks.bookkeeping();
    for (const [connection, c] of this.open) {
      for (const data of this.frames.get(connection) ?? [])
        note(hooks, {
          invocation: bookkeeping(),
          target: `WebSocket:${connection}`,
          op: "message",
          args: { connection, data },
          allowed: [],
        });
      if (c.closed)
        note(hooks, {
          invocation: bookkeeping(),
          target: `WebSocket:${connection}`,
          op: "close",
          args: { connection, code: c.closed.code, reason: c.closed.reason },
          allowed: [],
        });
    }
    this.frames.clear();
  }

  /** Before a run: close what the last run left open (it ended early), and let the closes cross before the objects are evicted. */
  async clear(): Promise<void> {
    this.generation++;
    let closing = this.dropUnclaimed("run over");
    for (const c of this.open.values()) {
      if (c.closed) continue;
      closing = true;
      try {
        c.client.close(1000, "run over");
      } catch {
        // already closed by the other side
      }
    }
    this.open.clear();
    this.frames.clear();
    this.earlyClosed.clear();
    this.opened.clear();
    this.delivered.clear();
    this.upgrades.length = 0;
    if (closing) await settleFrames();
  }
}

/** The upgrade request a connection opens with. */
export function upgradeRequest(c: WebSocketConnectionSpec): Request {
  const headers = new Headers(c.headers);
  headers.set("Upgrade", "websocket");
  headers.set("Connection", "Upgrade");
  return new Request(`${requestOrigin}${c.path}`, { headers });
}

/** A frame's data as recorded: JSON where it parses, the text otherwise. */
export function frameData(data: unknown): JsonValue {
  const text = typeof data === "string" ? data : "<binary>";
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/** The text a message is sent as: a string as is, any other JSON value as its JSON. */
export function frameText(data: JsonValue): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

/** Two turns of the real event loop: what a frame, or a close, needs to cross from one end of the pair to the other. */
async function settleFrames(): Promise<void> {
  await realTick();
  await realTick();
}

export interface WebSocketDeps {
  readonly worker: RunningWorker;
  readonly connections: Connections;
  readonly objects: ObjectAccess;
}

export async function deliverWebSocket(
  event: EventRef,
  hooks: RunHooks,
  _spec: ScenarioSpec,
  drive: WebSocketDrive,
  deps: WebSocketDeps,
): Promise<DeliveryResult> {
  const data = event.data as unknown as WebSocketEventData;
  const c = drive.connections.find((x) => x.id === data.connection);
  if (!c) throw new Error(`websocket drive has no connection ${data.connection}`);
  switch (data.kind) {
    case "open":
      try {
        return await openConnection(event, hooks, drive, c, deps);
      } finally {
        deps.connections.gate(deps.connections.opened, c.id).resolve();
      }
    case "message":
      try {
        return await deliverMessage(event, hooks, c, data, deps);
      } finally {
        deps.connections.gate(deps.connections.delivered, `${c.id}:${data.index}`).resolve();
      }
  }
}

/** What an open finds in the object: this connection's server end, or why there is none. */
type Found =
  | { readonly server: WebSocket; readonly identity: Identity }
  | { readonly unbound: readonly WebSocket[]; readonly lost: readonly Connection[] };

async function openConnection(
  event: EventRef,
  hooks: RunHooks,
  drive: WebSocketDrive,
  c: WebSocketConnectionSpec,
  deps: WebSocketDeps,
): Promise<DeliveryResult> {
  const invocation = invocationOf(event);
  const inv = hooks.startInvocation(invocation);
  const target = `WebSocket:${c.id}`;
  const background: Promise<unknown>[] = [];
  const handler = deps.worker.handler.fetch;
  if (!handler) throw new Error("the Worker has no fetch() handler");
  const position = drive.connections.findIndex((x) => x.id === c.id);
  const previous = drive.connections[position - 1];
  // Opens run one at a time, in order, so the socket an object accepts during this one is this
  // connection's; the wait is this invocation's, which the scheduler can see and abandon. Messages are
  // not held back this way.
  const handled = await runInvocation(hooks, inv, async () => {
    if (previous) await deps.connections.openedOf(previous.id);
    return handler.call(
      deps.worker.handler,
      upgradeRequest(c),
      deps.worker.env,
      executionContext(background),
    );
  });
  let status: DeliveryResult["status"] = handled.status;
  const response = handled.status === "completed" ? handled.value : undefined;
  const args: JsonValue = { connection: c.id, path: c.path };
  if (status === "completed" && response) {
    const r = response;
    // The open as one effect: the answer, and, on a 101, the client end accepted and the server end
    // found in the object. The waits inside are I/O of this invocation, which the scheduler sees.
    const opened = await runInvocation(hooks, inv, () =>
      hooks.effect(
        { invocation, target, op: "open", args, allowed: [], hostsEffects: true },
        async () => {
          const summary = { status: r.status, ok: r.status === 101 };
          if (r.status !== 101 || !r.webSocket) return summary;
          const client = r.webSocket;
          const upgrade = deps.connections.upgraded(invocation);
          if (!upgrade) {
            hooks.unsupported(
              `WebSocket ${c.id}: the Worker answered the upgrade itself; only connections a Durable Object accepts are modelled`,
            );
            dropEnd(client, "not modelled");
            return summary;
          }
          // Kept, not recorded: when a frame crosses the pair is the event loop's doing, so the end of
          // the run records them in arrival order. A close the object makes is kept the same way.
          const generation = deps.connections.generation;
          client.addEventListener("message", (ev: MessageEvent) => {
            deps.connections.received(generation, c.id, frameData(ev.data));
          });
          client.addEventListener("close", (ev: CloseEvent) => {
            deps.connections.closedBy(generation, c.id, ev.code, ev.reason);
          });
          client.accept();
          await settleFrames();
          // Closed by the object while it answered the upgrade: open and closed at once, nothing to send on.
          const early = deps.connections.earlyClosed.get(c.id);
          if (early) {
            deps.connections.open.set(c.id, {
              spec: c,
              client,
              server: undefined,
              identity: { tags: "[]", attachment: "null" },
              upgrade,
              closed: early,
            });
            return summary;
          }
          // The server end: the one socket the object holds that no connection does.
          const found = await deps.objects.run(
            upgrade.binding,
            upgrade.id,
            upgrade.object,
            async (_i, live): Promise<Found> => {
              const { unbound, lost } = deps.connections.rebind(upgrade, live);
              const server = unbound[0];
              if (lost.length > 0 || unbound.length !== 1 || !server) return { unbound, lost };
              return { server, identity: identityOf(server, live) };
            },
          );
          if (!found || !("server" in found)) {
            // Accepted above: closing it from here reaches the object.
            client.close(1011, "not modelled");
            const lost = found?.lost ?? [];
            const n = found?.unbound.length ?? 0;
            hooks.unsupported(
              lost.length > 0
                ? `WebSocket ${c.id}: the connections ${lost.map((l) => l.spec.id).join(", ")} of ${upgrade.object} cannot be told apart after its instance was dropped; give each socket an attachment or a tag`
                : `WebSocket ${c.id}: ${n === 0 ? "the object accepted no WebSocket with the Hibernation API (ctx.acceptWebSocket); the standard API is not modelled" : `${n} sockets were accepted by ${upgrade.object} during this open, so this connection's cannot be told apart`}`,
            );
            return summary;
          }
          deps.connections.open.set(c.id, {
            spec: c,
            client,
            server: found.server,
            identity: found.identity,
            upgrade,
            closed: undefined,
          });
          return summary;
        },
        (v) => v,
      ),
    );
    if (opened.status !== "completed") status = opened.status;
  } else {
    // The Worker did not answer: an object it reached meanwhile sees its connection close, as when a
    // Worker dies holding one. An uncaught exception is answered with a 500; so is the connection's open.
    const upgrade = deps.connections.upgraded(invocation);
    // The runtime hands the object the close before any later call reaches it (events enter an
    // object in arrival order), so the snapshot sees what webSocketClose wrote.
    if (upgrade) dropEnd(upgrade.client, "the Worker died during the upgrade");
    if (status === "errored")
      hooks.effectSync(
        { invocation, target, op: "open", args, allowed: [] },
        () => ({ status: 500, ok: false }),
        (v) => v,
      );
  }
  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  return { status, followUps: [] };
}

async function deliverMessage(
  event: EventRef,
  hooks: RunHooks,
  c: WebSocketConnectionSpec,
  data: Extract<WebSocketEventData, { kind: "message" }>,
  deps: WebSocketDeps,
): Promise<DeliveryResult> {
  const invocation = invocationOf(event);
  const inv = hooks.startInvocation(invocation);
  const target = `WebSocket:${c.id}`;
  // Its connection must be open and the message before it handled. Waited for as a run of this
  // invocation, which the scheduler can see and abandon; the effect then starts in a run of its own,
  // so this invocation is the one running when the object's handler makes its effects.
  const waited = await runInvocation(hooks, inv, async () => {
    await Promise.all([
      deps.connections.openedOf(c.id),
      deps.connections.deliveredOf(c.id, data.index - 1),
    ]);
    return null;
  });
  if (waited.status !== "completed") return { status: waited.status, followUps: [] };
  const conn = deps.connections.open.get(c.id);
  const args: JsonValue = {
    connection: c.id,
    object: conn?.upgrade.object ?? null,
    message: data.message,
    data: data.data,
  };
  // Nothing to send on: the open failed or was refused, or the object closed the connection since.
  const server = conn?.server;
  if (!conn || conn.closed || !server) {
    hooks.effectSync(
      { invocation, target, op: "send", args, allowed: [] },
      () => ({ delivered: false }),
      (v) => v,
    );
    return { status: "completed", followUps: [] };
  }
  const { binding, id, object } = conn.upgrade;
  // A crash is the object's: its in-memory state goes with the instance; the connection stays.
  const status = await hostedInObject(
    hooks,
    inv,
    deps.objects,
    binding,
    id,
    object,
    { invocation, target, op: "send", args, allowed: readFaults },
    async () => {
      await deps.objects.run(binding, id, object, async (instance, live) => {
        // A dropped instance left the connection's server end under a new identity: find it again.
        const { lost } = deps.connections.rebind(conn.upgrade, live);
        if (lost.includes(conn)) {
          hooks.unsupported(
            `WebSocket ${c.id}: the connections ${lost.map((l) => l.spec.id).join(", ")} of ${object} cannot be told apart after its instance was dropped; give each socket an attachment or a tag`,
          );
          return;
        }
        // The runtime would answer these without waking the object; delivering to the handler would not.
        if (live.getWebSocketAutoResponse()) {
          hooks.unsupported(
            `Durable Object ${binding} ${object} uses setWebSocketAutoResponse, which is not modelled`,
          );
          return;
        }
        const handler = (instance as { webSocketMessage?: unknown }).webSocketMessage;
        if (typeof handler !== "function") {
          hooks.unsupported(
            `Durable Object ${binding} ${object} has no webSocketMessage handler; only the Hibernation API is modelled`,
          );
          return;
        }
        const end = conn.server ?? server;
        await hooks.hostedCode(hostOf(`DO:${binding}`, object), () =>
          (handler as (ws: WebSocket, m: string) => Promise<unknown>).call(
            instance,
            end,
            frameText(data.data),
          ),
        );
        // The handler may have rewritten the attachment: keep what identifies the end current.
        conn.identity = identityOf(end, live);
      });
      // The frames the object sent back, or its close, cross to the client end now.
      await settleFrames();
      return { delivered: true };
    },
    (v) => v,
  );
  // No retry follows a message, so the instance is rebuilt here, within the run, where its
  // constructor is observed (an alarm's retry does that for an alarm); an object rebuilt only for
  // the snapshot would make the run UNSUPPORTED.
  if (status === "crashed") {
    // An effect of a run of its own (the crashed invocation is over), so the scheduler sees the
    // wait and the constructor's effects have an invocation.
    const rebuild = hooks.startInvocation(`${invocation}/rebuild`);
    await runInvocation(hooks, rebuild, () =>
      hooks.effect(
        {
          invocation: rebuild.id,
          target,
          op: "rebuild",
          args: { connection: c.id, object },
          allowed: [],
          hostsEffects: true,
        },
        async () => {
          await deps.objects.run(binding, id, object, async () => undefined);
          return null;
        },
        () => null,
      ),
    );
  }
  return { status, followUps: [] };
}
