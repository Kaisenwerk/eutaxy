import { describe, expect, test } from "vitest";
import { atLeastOnce, atLeastOncePerMessage, atMostOncePerKey } from "./index.ts";

const write = { target: "D1:DB", op: "run", kind: "result" } as const;

describe("delivery invariant constructors", () => {
  test("build the invariant data", () => {
    expect(atMostOncePerKey("once", write, "args.params.0")).toEqual({
      kind: "atMostOncePerKey",
      name: "once",
      effect: write,
      key: "args.params.0",
    });
    expect(atLeastOnce("all", write, "args.params.0", ["o-1"])).toEqual({
      kind: "atLeastOnce",
      name: "all",
      effect: write,
      key: "args.params.0",
      expected: ["o-1"],
    });
  });

  test("atLeastOncePerMessage derives the expected keys from the bodies", () => {
    const messages = [
      { id: "m1", body: { order: { id: "o-1" } } },
      { id: "m2", body: { order: { id: "o-2" } } },
    ];
    const inv = atLeastOncePerMessage("all", messages, write, "args.params.0", "order.id");
    expect(inv.expected).toEqual(["o-1", "o-2"]);
    expect(inv.perMessage).toEqual({ bodyKey: "order.id" });
  });

  test("atLeastOncePerMessage refuses a body without the key", () => {
    expect(() =>
      atLeastOncePerMessage("all", [{ id: "m1", body: { nope: 1 } }], write, "k", "orderId"),
    ).toThrow(/event m1 has no "orderId" in its body/);
  });
});
