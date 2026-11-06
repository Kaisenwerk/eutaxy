import { describe, expect, test } from "vitest";
import { HeldOutput } from "./held-output.ts";

const drained = (h: HeldOutput): string => {
  let out = "";
  h.drain((t) => {
    out += t;
  });
  return out;
};

describe("HeldOutput", () => {
  test("under the limit, it stays in memory and comes back in order", () => {
    const h = new HeldOutput(100);
    h.push("one ");
    h.push("two");
    expect(h.spilled).toBe(false);
    expect(drained(h)).toBe("one two");
    expect(drained(h)).toBe("");
  });

  test("past the limit, it goes to a file and comes back whole, multi-byte characters included", () => {
    // Read back three bytes at a time, so the four-byte and two-byte characters straddle reads.
    const h = new HeldOutput(4, 3);
    const parts = ["ab", "cd", "é𝄞x", "\n", "Ω".repeat(50)];
    for (const p of parts) h.push(p);
    expect(h.spilled).toBe(true);
    expect(drained(h)).toBe(parts.join(""));
    expect(h.spilled).toBe(false);
  });

  test("text pushed after a spill stays behind what is already in the file", () => {
    const h = new HeldOutput(2);
    h.push("x");
    h.push("long");
    h.push("y");
    expect(drained(h)).toBe("xlongy");
  });
});
