import { describe, expect, test } from "vitest";
import { goalFileFor, proofFileFor, renderGoals } from "./goals.ts";
import { leanVersion } from "./lean.ts";
import { readSupplied, refusedIn } from "./supplied.ts";

const goals = [
  {
    function: "schedules",
    property: "countIsProduct",
    statement: "∀ (v_levels : List (List String)),\n    (decide (x = y) = true)",
    reason: "omega could not prove the goal",
  },
  {
    function: "sum",
    property: "sumOfOne",
    statement: "∀ (v_xs : List Int),\n    (h = true) →\n    (c = true)",
    reason: "unsolved goals #check this",
  },
  {
    function: "run_task",
    property: "taskEnds",
    statement: "∀ (v_n : Int),\n    (decide (f_run_task v_n = 0) = true)",
    reason: "the section variable",
  },
];
const file = renderGoals({
  specFile: "domain.props.ts",
  sourceSha256: "a".repeat(64),
  specSha256: "b".repeat(64),
  goals,
});
const omitted = "-- (a line left out: it held a word a proof file may not use)";

describe("renderGoals", () => {
  test("names the files, carries the hashes, states each goal and leaves each proof open, proofs last", () => {
    expect(goalFileFor("domain.props.ts")).toBe("domain.props.goals.lean");
    expect(proofFileFor("domain.props.ts")).toBe("domain.props.lean");
    expect(file).toContain(
      `-- Open proof goals for domain.props.ts, written by Eutaxy's Lean engine (Lean ${leanVersion}).`,
    );
    expect(file).toContain(`-- eutaxy-source-sha256: ${"a".repeat(64)}`);
    expect(file).toContain(`-- eutaxy-spec-sha256: ${"b".repeat(64)}`);
    expect(file).toContain(
      "-- goal: countIsProduct, a property of f_schedules\n-- Lean said: omega could not prove the goal\n-- statement:\n--   ∀ (v_levels : List (List String)),\n--       (decide (x = y) = true)\n",
    );
    expect(file).toMatch(
      /-- proof: countIsProduct\n {2}-- tactics here\n\n-- proof: sumOfOne\n {2}-- tactics here\n\n-- proof: taskEnds\n {2}-- tactics here\n$/,
    );
  });

  test("a line that would refuse the file is left out with a note; a function named by a refused word appears by its Lean identifier", () => {
    expect(file).toContain(`-- goal: sumOfOne, a property of f_sum\n${omitted}\n-- statement:`);
    expect(file).not.toContain("#check");
    expect(file).toContain(
      `-- goal: taskEnds, a property of f_run_task\n${omitted}\n-- statement:\n--   ∀ (v_n : Int),\n--       (decide (f_run_task v_n = 0) = true)`,
    );
    expect(file).not.toContain("section");
  });

  test("reads back as a proof file with open proofs and the hashes, refused by nothing", () => {
    expect(refusedIn(file)).toBeUndefined();
    const supplied = readSupplied("domain.props.lean", file);
    expect(supplied.refused).toBeUndefined();
    expect([...supplied.proofs.keys()]).toEqual(["countIsProduct", "sumOfOne", "taskEnds"]);
    expect(supplied.proofs.get("countIsProduct")).toBe("  -- tactics here");
    expect(supplied.sourceSha256).toBe("a".repeat(64));
    expect(supplied.specSha256).toBe("b".repeat(64));
    // Without the lines, no hashes; a malformed hash is no hash.
    expect(readSupplied("p.lean", "-- proof: a\n  simp\n").sourceSha256).toBeUndefined();
    expect(
      readSupplied("p.lean", "-- eutaxy-source-sha256: nope\n-- proof: a\n  simp\n").sourceSha256,
    ).toBeUndefined();
  });
});
