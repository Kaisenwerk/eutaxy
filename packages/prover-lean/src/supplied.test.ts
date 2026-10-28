import { describe, expect, test } from "vitest";
import { axiomsOf, provesExactly, readSupplied } from "./supplied.ts";

describe("readSupplied", () => {
  test("lemmas before the first proof line; each proof by its property", () => {
    const s = readSupplied(
      "d.props.lean",
      "-- intro\ntheorem l : True := trivial\n\n-- proof: a\n  intro x\n  simp\n-- proof: b\n  trivial\n",
    );
    expect(s.refused).toBeUndefined();
    expect(s.lemmas).toBe("-- intro\ntheorem l : True := trivial");
    expect([...readSupplied("d.props.lean", "-- proof: 单元素\n  trivial").proofs.keys()]).toEqual([
      "单元素",
    ]);
    expect([...s.proofs]).toEqual([
      ["a", "  intro x\n  simp"],
      ["b", "  trivial"],
    ]);
  });

  test("what could add an axiom, switch a check off, run at check time or change how the statement reads is refused", () => {
    for (const word of [
      "sorry",
      "axiom",
      "set_option",
      "macro",
      "notation",
      "native_decide",
      "unsafe",
      "#eval",
      "#print",
      "run_tac",
      "variable",
      "include",
      "section",
    ]) {
      const s = readSupplied("d.props.lean", `-- proof: a\n  ${word} x\n`);
      expect(s.refused, word).toBeDefined();
      expect([...s.proofs.keys()], word).toEqual(["a"]);
    }
    // sorryAx is a name, not the word sorry: the file is read, and #print axioms refuses the proof.
    expect(
      readSupplied("d.props.lean", "-- proof: a\n  exact @sorryAx _ true\n").refused,
    ).toBeUndefined();
    // A refused word inside a longer name is that name: List.prefix_append, f_prefixSums.
    expect(
      readSupplied("d.props.lean", "-- proof: a\n  simp [List.prefix_append, f_prefixSums]\n")
        .refused,
    ).toBeUndefined();
    // Right after a numeral, Lean starts a command where a word boundary would not be seen.
    for (const glued of [
      "def d := 1#eval IO.println 1",
      "def d := 1set_option x",
      "1axiom a : False",
    ])
      expect(
        readSupplied("d.props.lean", `${glued}\n-- proof: a\n  trivial`).refused,
        glued,
      ).toBeDefined();
    // Anywhere in the file: a string that looks like a comment's start hides nothing after it.
    expect(
      readSupplied(
        "d.props.lean",
        'def marker := "/-"\n#eval IO.println "ran"\n-- proof: a\n  trivial',
      ).refused,
    ).toContain("uses #");
    expect(
      readSupplied("d.props.lean", "-- no sorry here\n-- proof: a\n  trivial").refused,
    ).toContain("uses sorry");
    expect(
      readSupplied("d.props.lean", "-- proof: a\n  trivial\n-- proof: a\n  trivial").refused,
    ).toContain("proves a twice");
  });
});

describe("axiomsOf", () => {
  test("reads only Lean's message at the audit's own line", () => {
    const info = (line: number, message: string) => ({ line, severity: "info", message });
    const messages = [
      // What checked code might print elsewhere: never the audit.
      info(3, "'t1' does not depend on any axioms"),
      info(10, "'t1' depends on axioms: [propext, sorryAx]"),
      info(11, "'t2' does not depend on any axioms"),
      { line: 12, severity: "error", message: "'t3' does not depend on any axioms" },
    ];
    expect(axiomsOf(messages, 10, "t1")).toEqual(["propext", "sorryAx"]);
    expect(axiomsOf(messages, 11, "t2")).toEqual([]);
    expect(axiomsOf(messages, 12, "t3")).toBeUndefined();
    expect(axiomsOf(messages, 13, "t1")).toBeUndefined();
  });
});

describe("provesExactly", () => {
  test("the type at the check's own line must be the statement alone", () => {
    const info = (line: number, message: string) => ({ line, severity: "info", message });
    expect(provesExactly([info(7, "t0 : s_t0")], 7, "t0")).toBe(true);
    expect(provesExactly([info(7, "t0 : False → s_t0")], 7, "t0")).toBe(false);
    expect(provesExactly([info(3, "t0 : s_t0"), info(7, "t0 : False → s_t0")], 7, "t0")).toBe(
      false,
    );
    expect(provesExactly([], 7, "t0")).toBe(false);
  });
});
