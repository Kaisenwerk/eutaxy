import { recomputePerMessageExpected } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import type { ObjectAccess } from "./object-access.ts";
import {
  atLeastOncePerMessage,
  defineScenario,
  driveEvents,
  durableObject,
  restrictDrive,
  websocket,
} from "./scenario.ts";
import {
  type CloseWatch,
  Connections,
  closeHandlerTurns,
  frameData,
  frameText,
  type UpgradeInfo,
  untilArrived,
  upgradeRequest,
  watchCloses,
} from "./websocket.ts";

const drive = websocket([
  { path: "/agents/room/r-1", messages: [{ data: { text: "a" } }, { id: "last", data: "bye" }] },
  { id: "other", path: "/agents/room/r-1", headers: { "x-user": "b" } },
]);

describe("websocket drive", () => {
  test("ids default to position, headers to none; the opens come first, then the messages a round at a time", () => {
    expect(drive.connections.map((c) => c.id)).toEqual(["conn-1", "other"]);
    expect(drive.connections[0]?.messages.map((m) => m.id)).toEqual(["conn-1:1", "last"]);
    expect(drive.connections[1]?.headers).toEqual({ "x-user": "b" });
    expect(driveEvents(drive).map((e) => e.id)).toEqual(["conn-1", "other", "conn-1:1", "last"]);
    expect(driveEvents(drive)[1]).toEqual({
      id: "other",
      attempt: 1,
      data: {
        kind: "open",
        connection: "other",
        path: "/agents/room/r-1",
        headers: { "x-user": "b" },
      },
    });
    const two = websocket([
      { path: "/a", messages: [{ data: 1 }, { data: 2 }] },
      { path: "/b", messages: [{ data: 3 }] },
    ]);
    expect(driveEvents(two).map((e) => e.id)).toEqual([
      "conn-1",
      "conn-2",
      "conn-1:1",
      "conn-2:1",
      "conn-1:2",
    ]);
    expect(driveEvents(two)[2]?.data).toEqual({
      kind: "message",
      connection: "conn-1",
      message: "conn-1:1",
      index: 0,
      data: 1,
    });
  });

  test("restricting drops connections with their messages, or single messages; the upgrade request carries the headers and the Upgrade", () => {
    const kept = restrictDrive(drive, ["other"]);
    expect(kept.kind === "websocket" && kept.connections.map((c) => c.id)).toEqual(["other"]);
    const fewer = restrictDrive(drive, ["conn-1", "last", "other"]);
    expect(fewer.kind === "websocket" && fewer.connections[0]?.messages.map((m) => m.id)).toEqual([
      "last",
    ]);
    const req = upgradeRequest(drive.connections[1] as (typeof drive.connections)[number]);
    expect(req.url).toBe("https://worker.test/agents/room/r-1");
    expect(req.headers.get("Upgrade")).toBe("websocket");
    expect(req.headers.get("x-user")).toBe("b");
  });

  test("per connection, keyed by its path: what the events re-derive is what the scenario expected", () => {
    const inv = atLeastOncePerMessage(
      "every-client-answered",
      drive,
      { target: "Fetch:audit", op: "POST", kind: "result" },
      "args.body.path",
      "",
    );
    expect(inv.expected).toEqual(["/agents/room/r-1", "/agents/room/r-1"]);
    // Shrinking re-derives from the remaining events' data: the opens carry the path, the messages do not.
    const [again] = recomputePerMessageExpected(
      [inv],
      driveEvents(drive).map((e) => e.data),
    );
    expect(again).toEqual(inv);
    const [fewer] = recomputePerMessageExpected(
      [inv],
      driveEvents(restrictDrive(drive, ["other"])).map((e) => e.data),
    );
    expect(fewer?.kind === "atLeastOnce" && fewer.expected).toEqual(["/agents/room/r-1"]);
    expect(() =>
      atLeastOncePerMessage("k", drive, { target: "Fetch:audit" }, "args.body.path", "user"),
    ).toThrow(/keys each connection by its path/);
  });

  test("frames: JSON where it parses, text otherwise; a message's text is its JSON unless it is a string", () => {
    expect(frameData('{"type":"count","count":2}')).toEqual({ type: "count", count: 2 });
    expect(frameData("plain")).toBe("plain");
    expect(frameData(new ArrayBuffer(2))).toBe("<binary>");
    expect(frameText({ text: "a" })).toBe('{"text":"a"}');
    expect(frameText("bye")).toBe("bye");
  });

  test("validation: a connection, paths, and ids distinct from one another", () => {
    const base = {
      name: "v",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      setup: [durableObject("ROOM", { r: {} })],
      invariants: [
        {
          kind: "atLeastOnce" as const,
          name: "x",
          effect: { target: "WebSocket:conn-1", op: "message", kind: "result" as const },
          key: "args.data.count",
          expected: [2],
        },
      ],
    };
    expect(() => defineScenario({ ...base, drive: websocket([]) })).toThrow(
      /needs at least one connection/,
    );
    expect(() => defineScenario({ ...base, drive: websocket([{ path: "agents/x" }]) })).toThrow(
      /must start with "\/"/,
    );
    expect(() =>
      defineScenario({
        ...base,
        drive: websocket([
          { id: "a", path: "/x" },
          { id: "a", path: "/x" },
        ]),
      }),
    ).toThrow(/duplicate connection id "a"/);
    expect(() =>
      defineScenario({
        ...base,
        drive: websocket([{ id: "a", path: "/x", messages: [{ id: "a", data: 1 }] }]),
      }),
    ).toThrow(/duplicate message id "a"/);
    expect(() => defineScenario({ ...base, drive })).not.toThrow();
  });
});

describe("waiting for what is on its way", () => {
  /** Turns of the event loop that pass without real time, counted. */
  const turns = () => {
    let passed = 0;
    return {
      tick: async () => {
        passed++;
      },
      get passed() {
        return passed;
      },
    };
  };

  test("untilArrived waits until it has arrived, however many turns that takes, not a fixed number", async () => {
    const loop = turns();
    let arrivesAt = 7;
    expect(await untilArrived(() => loop.passed >= arrivesAt, 100, loop.tick)).toBe(true);
    expect(loop.passed).toBe(7);
    // Already there: no turn is taken.
    expect(await untilArrived(() => true, 100, loop.tick)).toBe(true);
    expect(loop.passed).toBe(7);
    // Never there: the bound, and it says it did not arrive.
    arrivesAt = Number.POSITIVE_INFINITY;
    expect(await untilArrived(() => loop.passed >= arrivesAt, 5, loop.tick)).toBe(false);
    expect(loop.passed).toBe(12);
  });

  type Handler = { webSocketClose(ws: object, code?: number): Promise<void> };
  const watched = (instance: object): CloseWatch => {
    const watch = watchCloses(instance);
    if (typeof watch === "string") throw new Error(`not watched: ${watch}`);
    return watch;
  };

  test("watchCloses tells which socket's close the handler has returned from, on the instance it is given", async () => {
    let release: () => void = () => {};
    class Room {
      async webSocketClose(_ws: object): Promise<void> {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    }
    const first = new Room();
    const watch = watched(first);
    // Watched once: the same watch again.
    expect(watchCloses(first)).toBe(watch);
    const [ann, bob] = [{}, {}];
    const handling = first.webSocketClose(ann);
    // Started, not returned: running, and not handled yet.
    await Promise.resolve();
    expect([watch.running, watch.handled.has(ann)]).toEqual([1, false]);
    release();
    await handling;
    expect([watch.running, watch.handled.has(ann), watch.handled.has(bob)]).toEqual([
      0,
      true,
      false,
    ]);
    // Another instance of the class is not watched until it is given: its closes are its own.
    const second = new Room();
    const unwatched = second.webSocketClose(bob);
    release();
    await unwatched;
    expect(watch.handled.has(bob)).toBe(false);

    // A handler that throws has returned too.
    class Failing {
      async webSocketClose(_ws: object): Promise<void> {
        throw new Error("boom");
      }
    }
    const failing = new Failing();
    const failed = watched(failing);
    await expect(failing.webSocketClose(ann)).rejects.toThrow("boom");
    expect([failed.running, failed.handled.has(ann)]).toEqual([0, true]);

    // A handler a framework put on the instance itself, read-only: watched there, and called as the instance's.
    const seen: unknown[] = [];
    const host = {};
    Object.defineProperty(host, "webSocketClose", {
      configurable: true,
      value: async function (this: unknown, ws: object, code: number) {
        seen.push(this, ws, code);
      },
    });
    const own = watched(host);
    await (host as Handler).webSocketClose(ann, 1000);
    expect(seen).toEqual([host, ann, 1000]);
    expect(own.handled.has(ann)).toBe(true);

    // No handler: nothing to wait for. One that cannot be wrapped: not known when it has finished.
    expect(watchCloses({})).toBe("none");
    expect(watchCloses(null)).toBe("none");
    expect(watchCloses(Object.freeze(new Failing()))).toBe("unwatchable");
    const fixed = {};
    Object.defineProperty(fixed, "webSocketClose", { value: async () => {} });
    expect(watchCloses(fixed)).toBe("unwatchable");
  });

  /** An object as the teardown enters it: the instance it is now, and the hibernatable sockets it holds. */
  const room = (instance: object) => {
    const state = { instance, held: [] as object[] };
    const objects: ObjectAccess = {
      run: async (_binding, _id, _object, fn) =>
        fn(state.instance, {
          getWebSockets: () => [...state.held],
        } as unknown as DurableObjectState),
      abort: () => {},
      mayPark: () => true,
      evict: async () => {},
    };
    const connections = new Connections();
    const upgradeOf = (id: string, client: WebSocket): UpgradeInfo => ({
      binding: "ROOM",
      id: "room",
      object: "lobby",
      invocation: `${id}#1`,
      client,
    });
    /** The runtime hands the close of `server` to the handler the instance has then, `lateBy` turns of the event loop on. */
    const dispatch = (server: object, lateBy: number): void => {
      let turn = 0;
      const later = (): void => {
        if (++turn < lateBy) setTimeout(later, 0);
        else void (state.instance as Handler).webSocketClose(server);
      };
      setTimeout(later, 0);
    };
    return {
      state,
      objects,
      connections,
      upgradeOf,
      dispatch,
      /**
       * A connection open at the end of the run, its server end held by the object. Closing the
       * client end takes the socket from the object at once, as the runtime does, and the handler
       * is run `lateBy` turns later (never, without it).
       */
      open: (id: string, lateBy?: number): object => {
        const server = { of: id };
        state.held.push(server);
        const client = {
          close: () => {
            state.held.splice(state.held.indexOf(server), 1);
            if (lateBy !== undefined) dispatch(server, lateBy);
          },
        } as unknown as WebSocket;
        connections.open.set(id, {
          spec: { id, path: "/room" },
          client,
          server: undefined,
          identity: { tags: "[]", attachment: "null" },
          upgrade: upgradeOf(id, client),
          closed: undefined,
        } as never);
        return server;
      },
    };
  };
  const unfinished = `the webSocketClose handler of lobby had not finished ${closeHandlerTurns} turns of the event loop after the run closed its connections; what it does later would land in another run`;

  test("teardown waits for the object's close handler to return, though the object holds no socket any more", async () => {
    // The object as the teardown meets it on a loaded machine: the closed end is gone from its
    // sockets at once, and its handler runs some turns of the event loop later.
    const order: string[] = [];
    class Room {
      async webSocketClose(ws: { of: string }): Promise<void> {
        order.push(`${ws.of} handled`);
      }
    }
    const lateBy = 9;
    const lobby = room(new Room());
    lobby.open("ann", lateBy);
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    order.push("teardown returned");
    // The handler had returned before the teardown did: what it writes lands in this run.
    expect(order).toEqual(["ann handled", "teardown returned"]);
    expect(closeHandlerTurns).toBeGreaterThan(lateBy);
  });

  test("each run's teardown watches the instance it closes: a handler that lives on the instance is waited for in every run", async () => {
    // A framework gives each instance its own handler, and the object is a new instance after the
    // reset between runs: watching the first one alone would leave the second run's close unseen.
    const order: string[] = [];
    const instance = (name: string): object => {
      const host = {};
      Object.defineProperty(host, "webSocketClose", {
        configurable: true,
        value: async () => {
          order.push(`${name} handled`);
        },
      });
      return host;
    };
    const lobby = room(instance("first"));
    for (const run of ["first", "second"]) {
      lobby.state.instance = instance(run);
      lobby.open("ann", 3);
      expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
      order.push(`${run} run over`);
      lobby.connections.open.clear();
    }
    expect(order).toEqual(["first handled", "first run over", "second handled", "second run over"]);
  });

  test("a close already on its way does not stand in for the one the teardown sends", async () => {
    // Ann's end was closed during the run and her close is handled only now; bob's is closed by
    // the teardown and handled later still. The wait is for bob's socket, not for a close.
    const order: string[] = [];
    class Room {
      async webSocketClose(ws: { of: string }): Promise<void> {
        order.push(`${ws.of} handled`);
      }
    }
    const lobby = room(new Room());
    lobby.open("bob", 9);
    lobby.dispatch({ of: "ann" }, 2);
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    order.push("teardown returned");
    expect(order).toEqual(["ann handled", "bob handled", "teardown returned"]);
  });

  test("a call of the handler that began since the teardown watched it is waited for, beside the sockets", async () => {
    // Ann's end was closed during the run; her close is handled as the teardown waits for bob's,
    // and takes longer than his. The teardown ends when no call is still at work.
    const order: string[] = [];
    class Room {
      async webSocketClose(ws: { of: string }): Promise<void> {
        if (ws.of === "ann")
          for (let turn = 0; turn < 12; turn++)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        order.push(`${ws.of} handled`);
      }
    }
    const lobby = room(new Room());
    lobby.open("bob", 3);
    lobby.dispatch({ of: "ann" }, 1);
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    order.push("teardown returned");
    expect(order).toEqual(["bob handled", "ann handled", "teardown returned"]);
  });

  test("only the sockets the object holds are waited for: an end no handler sees ends nothing", async () => {
    // An upgrade no open claimed, accepted without the Hibernation API: the object has a close
    // handler, and no close of this end ever reaches it.
    class Room {
      async webSocketClose(): Promise<void> {}
    }
    const lobby = room(new Room());
    let dropped = false;
    const client = {
      accept: () => {},
      close: () => {
        dropped = true;
      },
    } as unknown as WebSocket;
    lobby.connections.upgradedTo(lobby.upgradeOf("ann", client));
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    expect(dropped).toBe(true);
  });

  test("an end no open claimed, held by the object, is waited for as an open connection is", async () => {
    const order: string[] = [];
    class Room {
      async webSocketClose(ws: { of: string }): Promise<void> {
        order.push(`${ws.of} handled`);
      }
    }
    const lobby = room(new Room());
    const server = { of: "ann" };
    lobby.state.held.push(server);
    const client = {
      accept: () => {},
      close: () => {
        lobby.state.held.length = 0;
        lobby.dispatch(server, 5);
      },
    } as unknown as WebSocket;
    lobby.connections.upgradedTo(lobby.upgradeOf("ann", client));
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    order.push("teardown returned");
    expect(order).toEqual(["ann handled", "teardown returned"]);
  });

  test("a connection the object closed is not closed again, and the close that answers it is waited for", async () => {
    const order: string[] = [];
    class Room {
      async webSocketClose(ws: { of: string }): Promise<void> {
        order.push(`${ws.of} handled`);
      }
    }
    const lobby = room(new Room());
    // Still among the object's sockets: the close the client end answered with has not been handled.
    const server = lobby.open("ann");
    const connection = lobby.connections.open.get("ann") as {
      closed: unknown;
      client: { close(): void };
    };
    connection.closed = { code: 1000, reason: "goodbye" };
    let closedAgain = false;
    connection.client.close = () => {
      closedAgain = true;
    };
    setTimeout(() => {
      lobby.state.held.length = 0;
      lobby.dispatch(server, 4);
    }, 0);
    expect(await lobby.connections.teardown(lobby.objects)).toBeUndefined();
    order.push("teardown returned");
    expect(order).toEqual(["ann handled", "teardown returned"]);
    expect(closedAgain).toBe(false);
  });

  test("a close that never reaches the handler is told, with the bound, and the teardown ends", async () => {
    class Room {
      async webSocketClose(): Promise<void> {}
    }
    const lobby = room(new Room());
    lobby.open("ann");
    expect(await lobby.connections.teardown(lobby.objects)).toBe(unfinished);
  }, 30_000);

  test("a handler that never returns is told the same way", async () => {
    class Stuck {
      webSocketClose(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }
    const lobby = room(new Stuck());
    lobby.open("ann", 1);
    expect(await lobby.connections.teardown(lobby.objects)).toBe(unfinished);
  }, 30_000);

  test("a handler that cannot be watched is told, once the connections are closed", async () => {
    class Room {
      async webSocketClose(): Promise<void> {}
    }
    const lobby = room(Object.freeze(new Room()));
    lobby.open("ann", 1);
    expect(await lobby.connections.teardown(lobby.objects)).toBe(
      "the webSocketClose handler of lobby cannot be watched (the object is frozen, or the handler is a fixed property of it); when it has finished after the run closed its connections is not known",
    );
    // Nothing of the run stays open for the next one.
    expect(lobby.state.held).toHaveLength(0);
  });
});
