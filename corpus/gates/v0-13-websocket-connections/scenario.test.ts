/** Runs inside workerd: WebSocket connections to a Durable Object, through a crash and a server-side close, with no UNSUPPORTED verdict. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import autoResponse from "./auto-response.sim.ts";
import serverClose from "./server-close.sim.ts";
import turnedAway from "./turned-away.sim.ts";
import twoClients from "./two-clients.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

type Entry = { invocation: string; kind: string; target: string; op: string; payload: unknown };
type Log = { entries: readonly Entry[] };
type Frame = { connection: string; data: { n: number; name: string; text: string } };
type Close = { connection: string; code: number; reason: string };

/** The result records of an op: invocation, target, and the payload's args and result. */
function results<A, R = unknown>(
  log: Log,
  op: string,
): { invocation: string; target: string; args: A; result: R }[] {
  return log.entries
    .filter((e) => e.kind === "result" && e.op === op)
    .map((e) => ({
      invocation: e.invocation,
      target: e.target,
      ...(e.payload as { args: A; result: R }),
    }));
}
const stored = (log: Log, key: string) =>
  lastSnapshot(log as never, "DO:ROOM")?.["lobby"]?.find((r) => r["key"] === key)?.["value"];

test("two clients, a crash on any send allowed: BOUNDED, nothing unsupported", async () => {
  const verdict = await check(twoClients, platform(), { seed: "gate", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("fault-free: every message is echoed with its number; the room saw no close before the snapshot", async () => {
  const log = await replay(twoClients, platform(), { seed: 0, faults: [] });
  expect(results(log, "open").map((r) => r.target)).toEqual(["WebSocket:ann", "WebSocket:bob"]);
  expect(results(log, "send").map((r) => r.result)).toEqual([
    { delivered: true },
    { delivered: true },
    { delivered: true },
  ]);
  const frames = results<Frame>(log, "message").map((r) => r.args);
  expect(frames.map((f) => `${f.connection}:${f.data.name}:${f.data.text}`)).toEqual([
    "ann:ann:one",
    "ann:ann:two",
    "bob:bob:three",
  ]);
  expect(new Set(frames.map((f) => f.data.n))).toEqual(new Set([1, 2, 3]));
  expect(results(log, "close")).toEqual([]);
  expect(stored(log, "messages")).toBe(3);
  expect(stored(log, "closes")).toBeUndefined();
});

test("the instance crashes after ann's first message: her connection survives and her second message reaches the new instance", async () => {
  const log = await replay(twoClients, platform(), {
    seed: 0,
    faults: [
      {
        invocation: "ann:1#1",
        ordinal: 0,
        fault: "crash_after",
        target: "WebSocket:ann",
        op: "send",
      },
    ],
  });
  expect(log.entries.some((e) => e.kind === "fault" && e.target === "WebSocket:ann")).toBe(true);
  const second = results(log, "send").find((r) => r.invocation === "ann:2#1");
  expect(second?.result).toEqual({ delivered: true });
  const frames = results<Frame>(log, "message").map((r) => r.args);
  expect(frames.filter((f) => f.connection === "ann").map((f) => f.data.text)).toEqual([
    "one",
    "two",
  ]);
  expect(stored(log, "messages")).toBe(3);
  expect(stored(log, "closes")).toBeUndefined();
});

test("the Worker dies after the room accepted ann: the room sees her connection close, and bob's open still finds its own socket", async () => {
  const log = await replay(twoClients, platform(), {
    seed: 0,
    faults: [
      { invocation: "ann#1", ordinal: 0, fault: "crash_after", target: "DO:ROOM", op: "fetch" },
    ],
  });
  expect(results(log, "open").map((r) => r.target)).toEqual(["WebSocket:bob"]);
  expect(results(log, "send").map((r) => [r.target, r.result])).toEqual([
    ["WebSocket:ann", { delivered: false }],
    ["WebSocket:ann", { delivered: false }],
    ["WebSocket:bob", { delivered: true }],
  ]);
  // The dropped end's close reached the room within the run; bob's connection outlives the snapshot.
  expect(results(log, "close")).toEqual([]);
  expect(stored(log, "close-1")).toBe(1011);
  expect(stored(log, "closes")).toBe(1);
});

test("the room closes a connection on bye: the client's next message is not delivered, and the close is the object's", async () => {
  const verdict = await check(serverClose, platform(), { seed: "gate", budgetMs: 10_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  const log = await replay(serverClose, platform(), { seed: 0, faults: [] });
  expect(results(log, "send").map((r) => r.result)).toEqual([
    { delivered: true },
    { delivered: true },
    { delivered: false },
  ]);
  expect(results<Close>(log, "close").map((r) => r.args)).toEqual([
    { connection: "ann", code: 1000, reason: "goodbye" },
  ]);
  expect(results(log, "message")).toHaveLength(1);
  expect(stored(log, "closes")).toBe(1);
});

test("the room turns a client away before answering the upgrade: the close is the object's, the message is not delivered", async () => {
  const verdict = await check(turnedAway, platform(), { seed: "gate", budgetMs: 10_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  const log = await replay(turnedAway, platform(), { seed: 0, faults: [] });
  expect(results(log, "open").map((r) => r.result)).toEqual([{ status: 101, ok: true }]);
  expect(results<Close>(log, "close").map((r) => r.args)).toEqual([
    { connection: "nobody", code: 4001, reason: "not welcome" },
  ]);
  expect(results(log, "send").map((r) => r.result)).toEqual([{ delivered: false }]);
  expect(stored(log, "close-1")).toBe(4001);
});

test("a room on the runtime's auto-response is refused, not mis-modelled", async () => {
  const verdict = await check(autoResponse, platform(), { seed: "gate", budgetMs: 10_000 });
  expect(verdict.kind, renderText(verdict)).toBe("UNSUPPORTED");
  expect(renderText(verdict)).toContain("setWebSocketAutoResponse");
});
