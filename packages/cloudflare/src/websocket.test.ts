import { recomputePerMessageExpected } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import {
  atLeastOncePerMessage,
  defineScenario,
  driveEvents,
  durableObject,
  restrictDrive,
  websocket,
} from "./scenario.ts";
import { frameData, frameText, upgradeRequest } from "./websocket.ts";

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
