import { describe, expect, test } from "vitest";
import { splitSql } from "./d1.ts";
import { toJson } from "./json.ts";

describe("splitSql", () => {
  test("splits statements and drops comments and blanks", () => {
    expect(
      splitSql("-- schema\nCREATE TABLE a (x);\n\nCREATE TABLE b (y); -- trailing\n/* c */"),
    ).toEqual(["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);
  });

  test("keeps semicolons, comment markers and doubled quotes inside literals and identifiers", () => {
    const create = `CREATE TABLE t (a TEXT DEFAULT 'a;b', b TEXT DEFAULT '--', c TEXT DEFAULT 'it''s', "we;ird" INT)`;
    expect(splitSql(`${create}; INSERT INTO t (a) VALUES (';');`)).toEqual([
      create,
      `INSERT INTO t (a) VALUES (';')`,
    ]);
  });

  test("keeps trigger bodies and CASE expressions whole", () => {
    const trigger =
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET n = CASE WHEN new.n > 0 THEN 1 ELSE 0 END; DELETE FROM u; END";
    expect(splitSql(`${trigger}; CREATE TABLE v (x);`)).toEqual([trigger, "CREATE TABLE v (x)"]);
  });
});

describe("toJson", () => {
  test("reduces runtime values to JSON data", () => {
    expect(
      toJson({ b: 1n, a: [undefined, Number.NaN, new Uint8Array(3)], d: new Date(0) }),
    ).toEqual({
      a: [null, "NaN", "<bytes 3>"],
      b: "1",
      d: "1970-01-01T00:00:00.000Z",
    });
    expect(toJson(() => 1)).toBe("<function>");
  });
});
