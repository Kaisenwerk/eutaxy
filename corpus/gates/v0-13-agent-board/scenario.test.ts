/** Runs inside workerd: the v0.13 gate's Agent, on SQLite storage with a schedule and WebSocket connections, holds with no UNSUPPORTED verdict. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import board from "./board.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({ env, handler, schemas: {}, durableObjects: cloudflareTest });

test("two clients posting at once, the digest over the schedule: BOUNDED, nothing unsupported", async () => {
  const verdict = await check(board, platform(), { seed: "gate", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("a run crosses every boundary: the opens, the posts, the screening calls, the alarm, the frames", async () => {
  const log = await replay(board, platform(), { seed: 0, faults: [] });
  const seen = new Set(
    log.entries.filter((e) => e.kind === "result").map((e) => `${e.target} ${e.op}`),
  );
  expect(seen).toContain("WebSocket:ann open");
  expect(seen).toContain("WebSocket:bob open");
  expect(seen).toContain("WebSocket:ann send");
  expect(seen).toContain("Fetch:screening POST");
  expect(seen).toContain("DO:BOARD alarm");
  const frames = log.entries
    .filter((e) => e.kind === "result" && e.op === "message")
    .map((e) => (e.payload as { args: { connection: string; data: { type: string } } }).args)
    .map((a) => `${a.connection}:${a.data.type}`);
  expect(frames.filter((f) => f.endsWith(":welcome"))).toEqual(["ann:welcome", "bob:welcome"]);
  expect(frames.filter((f) => f === "ann:posted")).toHaveLength(2);
  expect(frames.filter((f) => f === "bob:posted")).toHaveLength(1);
  expect(frames.filter((f) => f.endsWith(":count"))).toHaveLength(6);
  const tables = lastSnapshot(log as never, "DO:BOARD");
  expect(tables?.["b-1/items"]).toHaveLength(3);
  expect(tables?.["b-1/digests"]).toEqual([{ items: 3 }]);
});
