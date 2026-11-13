/**
 * Runs inside workerd: the part of the v0.17 gate for calls between
 * objects. A call one object makes into another through its own env is
 * the scenario's: an effect of the invocation the calling object's code
 * runs as, hosting what the called object does, and open to faults: the
 * call never arriving, its answer lost, the calling object dying after
 * it, and a crash inside the called object, which ends the invocation
 * and resets every object the call went through.
 */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectLog, FaultKind, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { describe, expect, test } from "vitest";
import { carts } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });

const ops = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

type Rows = Record<string, string | number>[];

/** What each object holds after the last event. */
function state(log: EffectLog) {
  const table = (target: string, name: string) =>
    (lastSnapshot(log as never, target)?.[name] ?? []) as unknown as Rows;
  return {
    c1: table("DO:CART", "c1/items").map((r) => r["item"]),
    c2: table("DO:CART", "c2/items").map((r) => r["item"]),
    shelf: table("DO:SHELF", "widget/takes").map((r) => `${r["cart"]} audited=${r["audited"]}`),
    audit: table("DO:AUDIT", "log/seen").map((r) => r["cart"]),
  };
}

/** The first cart holds the unit, the auditor knows, and the second cart was turned away. */
const settled = { c1: ["widget"], c2: [], shelf: ["c1 audited=1"], audit: ["c1"] };

async function replayed(concurrency: 1 | 2, schedule: Schedule) {
  const log = await replay(carts(concurrency, 2), platform(), schedule);
  return { log, lines: ops(log), state: state(log) };
}

const after = "DO:SHELF/widget/after";

/** One fault on `invocation`'s call `target` `op`, placed by where that call comes in it. */
async function withFault(invocation: string, fault: FaultKind, target: string, op: string) {
  const base = await replay(carts(1, 2), platform(), { seed: 0, faults: [] });
  const calls = base.entries.filter((e) => e.kind === "call" && e.invocation === invocation);
  const ordinal = calls.findIndex((e) => e.target === target && e.op === op);
  expect(ordinal, `${target} ${op} in ${invocation}`).toBeGreaterThanOrEqual(0);
  return replayed(1, { seed: 0, faults: [{ invocation, ordinal, fault, target, op }] });
}

describe.each([1, 2] as const)("with %i invocation(s) in flight", (concurrency) => {
  test.each([0, 1, 2])("up to %i fault(s): BOUNDED, nothing unsupported", async (faults) => {
    const verdict = await check(carts(concurrency, faults), platform(), {
      seed: "gate",
      budgetMs: 30_000,
      maxRuns: 150,
    });
    expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  });
});

test("every schedule with one fault holds, exhaustively", async () => {
  const verdict = await check(carts(1, 1), platform(), {
    seed: "gate",
    budgetMs: 100_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
});

describe("where the calls between objects are recorded", () => {
  test("each in the invocation the calling object's code runs as, hosting what the called object does", async () => {
    const { lines, state } = await replayed(1, { seed: 0, faults: [] });
    // The cart calls the shelf, which calls back into the cart waiting on it.
    expect(lines.filter((l) => l.startsWith("add-1#1 ")).slice(0, 6)).toEqual([
      "add-1#1 call DO:CART add",
      "add-1#1 call DO:SHELF take",
      "add-1#1 call DO:CART limit",
      "add-1#1 result DO:CART limit",
      "add-1#1 result DO:SHELF take",
      "add-1#1 result DO:CART add",
    ]);
    // After its answer the shelf calls the auditor as its own invocation, and the auditor calls
    // back into the shelf from inside that call.
    expect(lines.filter((l) => l.startsWith(`${after} `))).toEqual([
      `${after} call DO:AUDIT note`,
      `${after} call DO:SHELF audited`,
      `${after} result DO:SHELF audited`,
      `${after} result DO:AUDIT note`,
    ]);
    expect(lines.indexOf(`${after} call DO:AUDIT note`)).toBeGreaterThan(
      lines.indexOf("add-1#1 result Http:/carts/c1/widget response"),
    );
    // The second cart is asked too, and turned away: nothing is told to the auditor for it.
    expect(lines.filter((l) => l.startsWith("add-2#1 ")).slice(0, 6)).toEqual([
      "add-2#1 call DO:CART add",
      "add-2#1 call DO:SHELF take",
      "add-2#1 call DO:CART limit",
      "add-2#1 result DO:CART limit",
      "add-2#1 result DO:SHELF take",
      "add-2#1 result DO:CART add",
    ]);
    // A cart calling itself through its own namespace.
    expect(lines.filter((l) => l.startsWith("look-1#1 ")).slice(0, 4)).toEqual([
      "look-1#1 call DO:CART summary",
      "look-1#1 call DO:CART size",
      "look-1#1 result DO:CART size",
      "look-1#1 result DO:CART summary",
    ]);
    expect(state).toEqual(settled);
  });

  test("the same seed gives the same run, and two in flight interleave the objects' calls by the seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const once = await replayed(2, { seed, faults: [] });
      const twice = await replayed(2, { seed, faults: [] });
      expect(twice.lines).toEqual(once.lines);
      // Whichever cart got there first holds the one unit.
      expect(once.state.shelf).toHaveLength(1);
      expect([...once.state.c1, ...once.state.c2]).toEqual(["widget"]);
      orders.add(once.lines.filter((l) => l.includes(" call ")).join("\n"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("a fault on a call between objects", () => {
  test("the shelf's answer lost: the cart fails, its caller asks again, and the shelf gives the unit it gave", async () => {
    const { lines, state } = await withFault("add-1#1", "ambiguous", "DO:SHELF", "take");
    expect(lines).toContain("add-1#1 fault DO:SHELF take");
    // The resend finds the take held: the shelf does not ask the cart again.
    expect(lines.filter((l) => l.startsWith("add-1#2 ")).slice(0, 4)).toEqual([
      "add-1#2 call DO:CART add",
      "add-1#2 call DO:SHELF take",
      "add-1#2 result DO:SHELF take",
      "add-1#2 result DO:CART add",
    ]);
    expect(state).toEqual(settled);
  });

  test("the cart dying right after the shelf answered: the shelf keeps the take, and the resend keeps the item", async () => {
    const { lines, state } = await withFault("add-1#1", "crash_after", "DO:SHELF", "take");
    expect(lines).toContain("add-1#1 fault DO:SHELF take");
    expect(lines).toContain("add-1#2 result DO:CART add");
    expect(state).toEqual(settled);
  });

  test("a crash where the shelf calls back into the cart ends the invocation and resets both: nothing was given, and the next cart is given the unit", async () => {
    const { lines, state } = await withFault("add-1#1", "crash_before", "DO:CART", "limit");
    expect(lines).toContain("add-1#1 fault DO:CART limit");
    // The invocation ended there: no answer left the shelf or the cart.
    expect(lines).not.toContain("add-1#1 call Http:/carts/c1/widget response");
    // The second cart finds a shelf that gave nothing, and the first, sent again, is turned away.
    expect(state).toEqual({ c1: [], c2: ["widget"], shelf: ["c2 audited=1"], audit: ["c2"] });
  });

  test("the shelf's call to the auditor failing: the take stays unaudited until the watchdog tells the auditor again", async () => {
    const { lines, state } = await withFault(after, "error", "DO:AUDIT", "note");
    expect(lines).toContain(`${after} fault DO:AUDIT note`);
    const byTheWatchdog = lines.filter(
      (l) => l.startsWith("alarm:SHELF:widget:") && l.endsWith("call DO:AUDIT note"),
    );
    expect(byTheWatchdog).toHaveLength(1);
    expect(state).toEqual(settled);
  });

  test("the auditor's call back into the shelf acting and its answer lost: the shelf has marked the take, and nothing is told twice", async () => {
    const { lines, state } = await withFault(after, "ambiguous", "DO:SHELF", "audited");
    expect(lines).toContain(`${after} fault DO:SHELF audited`);
    expect(lines.filter((l) => l.endsWith("call DO:AUDIT note"))).toHaveLength(1);
    expect(state).toEqual(settled);
  });
});

describe("a crash inside an object another object's work called", () => {
  // The auditor calls back into the shelf from inside the call the shelf's work after its answer
  // made, and dies once that call back has committed. The crash is signalled in the auditor's
  // context and awaited in the shelf's, where the runtime's rejection of the call into the reset
  // auditor can arrive first: the run is the same whichever does, and no object stays referenced
  // into the next run.
  const schedule: Schedule = {
    seed: 222244113,
    faults: [
      { invocation: after, ordinal: 1, fault: "crash_after", target: "DO:SHELF", op: "audited" },
    ],
  };

  test("ends the work it happened in, records no answer of the call it was inside, and replays the same", async () => {
    const first = await replayed(2, schedule);
    const at = first.lines.indexOf(`${after} fault DO:SHELF audited`);
    expect(at).toBeGreaterThan(0);
    expect(first.lines.slice(at + 1).filter((l) => l.startsWith(`${after} `))).toEqual([]);
    for (let i = 0; i < 3; i++) expect((await replayed(2, schedule)).lines).toEqual(first.lines);
  });
});
