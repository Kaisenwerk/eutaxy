import { describe, expect, test } from "vitest";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import { checkInvariant } from "./invariants.ts";
import {
  type EveryRow,
  type Implies,
  lastSnapshot,
  queryRows,
  type References,
  rowMatches,
  type Unique,
} from "./state.ts";

function withSnapshot(log: EffectLog, tables: Record<string, unknown[]>): EffectLog {
  return appendEffect(log, {
    kind: "snapshot",
    invocation: "platform",
    target: "D1:DB",
    op: "snapshot",
    payload: { tables: tables as never },
  });
}

function ackResult(log: EffectLog, invocation: string, orderId: string): EffectLog {
  return appendEffect(log, {
    kind: "result",
    invocation,
    target: "Queue:payments",
    op: "ack",
    payload: { args: { messageId: invocation, orderId, implicit: false }, result: null },
  });
}

const balancesNonNegative: EveryRow = {
  kind: "everyRow",
  name: "balances-non-negative",
  query: { target: "D1:DB", table: "accounts" },
  holds: [{ column: "balance", op: "gte", value: 0 }],
};

const ackedHasRow: Implies = {
  kind: "implies",
  name: "acked-has-row",
  when: { target: "Queue:payments", op: "ack", kind: "result" },
  key: "args.orderId",
  state: { target: "D1:DB", table: "payments" },
  column: "order_id",
};

describe("rowMatches", () => {
  const row = { id: 1, name: "a", balance: 5, note: null };
  test("covers every operator", () => {
    expect(rowMatches(row, { column: "name", op: "eq", value: "a" })).toBe(true);
    expect(rowMatches(row, { column: "name", op: "neq", value: "b" })).toBe(true);
    expect(rowMatches(row, { column: "balance", op: "gt", value: 4 })).toBe(true);
    expect(rowMatches(row, { column: "balance", op: "gte", value: 5 })).toBe(true);
    expect(rowMatches(row, { column: "balance", op: "lt", value: 5 })).toBe(false);
    expect(rowMatches(row, { column: "balance", op: "lte", value: 5 })).toBe(true);
    expect(rowMatches(row, { column: "id", op: "in", value: [1, 2] })).toBe(true);
    expect(rowMatches(row, { column: "note", op: "notNull" })).toBe(false);
    expect(rowMatches(row, { column: "missing", op: "eq", value: 1 })).toBe(false);
    expect(rowMatches(row, { column: "name", op: "gt", value: 1 })).toBe(false);
  });
});

describe("snapshots and queries", () => {
  test("the last snapshot per target wins and queries filter rows", () => {
    let log = withSnapshot(emptyLog, { accounts: [{ name: "a", balance: 1 }] });
    log = withSnapshot(log, {
      accounts: [
        { name: "a", balance: 2 },
        { name: "b", balance: -1 },
      ],
    });
    expect(lastSnapshot(log, "D1:DB")?.["accounts"]).toHaveLength(2);
    expect(lastSnapshot(log, "D1:OTHER")).toBeUndefined();
    expect(
      queryRows(log, {
        target: "D1:DB",
        table: "accounts",
        where: [{ column: "balance", op: "lt", value: 0 }],
      }),
    ).toEqual([{ name: "b", balance: -1 }]);
    expect(queryRows(log, { target: "D1:DB", table: "nope" })).toEqual([]);
  });
});

describe("everyRow", () => {
  test("passes when all rows satisfy the condition", () => {
    const log = withSnapshot(emptyLog, {
      accounts: [
        { name: "a", balance: 0 },
        { name: "b", balance: 7 },
      ],
    });
    expect(checkInvariant(log, balancesNonNegative)).toBeNull();
  });

  test("reports the failing rows as keys with the snapshot as evidence", () => {
    const log = withSnapshot(emptyLog, {
      accounts: [
        { name: "a", balance: 0 },
        { name: "b", balance: -3 },
      ],
    });
    const v = checkInvariant(log, balancesNonNegative);
    expect(v?.keys).toEqual(['{"balance":-3,"name":"b"}']);
    expect(v?.evidence).toEqual([0]);
    expect(v?.message).toContain("1 row(s) of accounts");
  });

  test("a missing snapshot is a violation, never a silent pass", () => {
    expect(checkInvariant(emptyLog, balancesNonNegative)?.message).toContain("no snapshot");
  });
});

describe("implies", () => {
  test("passes when every selected effect has its row", () => {
    let log = ackResult(emptyLog, "msg-1", "o-1");
    log = ackResult(log, "msg-2", "o-2");
    log = withSnapshot(log, { payments: [{ order_id: "o-1" }, { order_id: "o-2" }] });
    expect(checkInvariant(log, ackedHasRow)).toBeNull();
  });

  test("reports acked keys without a row, with the effects as evidence", () => {
    let log = ackResult(emptyLog, "msg-1", "o-1");
    log = ackResult(log, "msg-2", "o-2");
    log = ackResult(log, "msg-2#2", "o-2");
    log = withSnapshot(log, { payments: [{ order_id: "o-1" }] });
    const v = checkInvariant(log, ackedHasRow);
    expect(v?.keys).toEqual(['"o-2"']);
    expect(v?.evidence).toEqual([1, 2]);
  });

  test("a missing snapshot is a violation", () => {
    const log = ackResult(emptyLog, "msg-1", "o-1");
    expect(checkInvariant(log, ackedHasRow)?.message).toContain("no snapshot");
  });
});

describe("unique", () => {
  const oneSlotPerProject: Unique = {
    kind: "unique",
    name: "one-slot-per-project",
    query: { target: "D1:DB", table: "slots" },
    path: "value.lease.project",
  };

  test("holds when no two rows share the value, and ignores rows where it is absent or null", () => {
    const log = withSnapshot(emptyLog, {
      slots: [
        { key: "slot:01", value: { lease: { project: "p-1" } } },
        { key: "slot:02", value: { lease: { project: "p-2" } } },
        { key: "slot:03", value: { lease: null } },
        { key: "slot:04", value: {} },
      ],
    });
    expect(checkInvariant(log, oneSlotPerProject)).toBeNull();
  });

  test("reports each shared value once, with the rows that share it", () => {
    const log = withSnapshot(emptyLog, {
      slots: [
        { key: "slot:01", value: { lease: { project: "p-1" } } },
        { key: "slot:02", value: { lease: { project: "p-1" } } },
        { key: "slot:03", value: { lease: { project: "p-1" } } },
      ],
    });
    const v = checkInvariant(log, oneSlotPerProject);
    expect(v?.keys).toEqual(['"p-1"']);
    expect(v?.message).toContain("3 rows of slots in D1:DB share value.lease.project");
  });

  test("a flat column works as a path too", () => {
    const log = withSnapshot(emptyLog, { leases: [{ slot: 1 }, { slot: 1 }] });
    expect(
      checkInvariant(log, {
        ...oneSlotPerProject,
        query: { target: "D1:DB", table: "leases" },
        path: "slot",
      })?.keys,
    ).toEqual(["1"]);
  });

  test("without a snapshot it is a violation, as for everyRow", () => {
    expect(checkInvariant(emptyLog, oneSlotPerProject)?.message).toContain("no snapshot");
  });
});

describe("references", () => {
  const objectsHaveVersions: References = {
    kind: "references",
    name: "objects-have-versions",
    query: { target: "R2:FILES", table: "objects" },
    path: "key",
    in: { target: "D1:DB", table: "versions" },
    column: "object_key",
  };
  const snap = (log: EffectLog, target: string, tables: Record<string, unknown[]>) =>
    appendEffect(log, {
      kind: "snapshot",
      invocation: "platform",
      target,
      op: "snapshot",
      payload: { tables: tables as never },
    });

  test("holds when every selected row is pointed at, and names the ones that are not", () => {
    let log = snap(emptyLog, "R2:FILES", {
      objects: [{ key: "t/1" }, { key: "t/2" }, { key: "t/3" }],
    });
    log = snap(log, "D1:DB", { versions: [{ object_key: "t/1" }, { object_key: "t/3" }] });
    const v = checkInvariant(log, objectsHaveVersions);
    expect(v?.keys).toEqual(['"t/2"']);
    expect(v?.message).toContain("no row of versions in D1:DB");
    expect(v?.evidence).toEqual([0, 1]);
    const fixed = snap(log, "D1:DB", {
      versions: [{ object_key: "t/1" }, { object_key: "t/2" }, { object_key: "t/3" }],
    });
    expect(checkInvariant(fixed, objectsHaveVersions)).toBeNull();
  });

  test("skips rows without the value, and a missing snapshot is a violation", () => {
    let log = snap(emptyLog, "R2:FILES", { objects: [{ key: null }, {}] });
    log = snap(log, "D1:DB", { versions: [] });
    expect(checkInvariant(log, objectsHaveVersions)).toBeNull();
    const noVersions = snap(emptyLog, "R2:FILES", { objects: [{ key: "t/1" }] });
    expect(checkInvariant(noVersions, objectsHaveVersions)?.message).toContain(
      "no snapshot of D1:DB",
    );
  });
});
