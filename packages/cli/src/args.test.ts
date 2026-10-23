import { describe, expect, test } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  test("separates positionals, valued flags, equals flags and booleans", () => {
    const p = parseArgs(
      [
        "check",
        "s.sim.ts",
        "--seed",
        "abc",
        "--json",
        "--out=x.ts",
        "--keep",
        "--wrangler",
        "w.jsonc",
      ],
      ["json", "keep"],
    );
    expect(p.positionals).toEqual(["check", "s.sim.ts"]);
    expect(p.flags).toEqual({
      seed: "abc",
      json: true,
      out: "x.ts",
      keep: true,
      wrangler: "w.jsonc",
    });
  });

  test("a flag before another flag or at the end is boolean", () => {
    expect(parseArgs(["--a", "--b", "v", "--c"]).flags).toEqual({ a: true, b: "v", c: true });
  });
});
