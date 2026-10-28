/**
 * The self-check: `eutaxy report` on Eutaxy's own core holds every
 * invariant checker to its naive reference (v0.8's gate needs each at
 * CHECKED or better), and would fail if a checker were wrong: each planted
 * bug below, made in a copy of the core's sources, is refuted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

interface Report {
  specs: { function: string; property: string; kind: string }[];
}

function report(dir: string): { status: number; report: Report } {
  let stdout: string;
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [bin, "report", dir, "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    status = e.status ?? 1;
    stdout = e.stdout ?? "";
  }
  return { status, report: JSON.parse(stdout) as Report };
}

const atLeastChecked = new Set(["CHECKED", "TESTED", "PROVEN"]);

describe("the self-check", () => {
  test("every invariant checker agrees with its reference: CHECKED or better", () => {
    const r = report("packages/core/src");
    expect(r.status).toBe(0);
    const checkers = r.report.specs.filter((s) => s.property.endsWith("MatchesReference"));
    expect(checkers.map((s) => s.function).sort()).toEqual([
      "atLeastOnceMissing",
      "atMostOnceDuplicate",
      "everyRowFailing",
      "impliesMissing",
      "referencesOrphans",
      "refinesOnState",
      "refinesViolation",
      "uniqueShared",
    ]);
    for (const s of checkers) expect(atLeastChecked.has(s.kind), s.property).toBe(true);
  }, 120_000);

  // Under packages/core so the copy resolves @eutaxy/spec; .probe-* is gitignored.
  test.each([
    {
      bug: "the selector ignores the effect kind",
      file: "selectors.ts",
      from: "if (sel.kind !== undefined && record.kind !== sel.kind) return false;",
      to: "",
      refuted: ["atMostOnceMatchesReference", "atLeastOnceMatchesReference"],
    },
    {
      bug: "a repeated key is forgotten after its second occurrence",
      file: "invariants.ts",
      from: "        seen.set(k, e.seq);\n      }\n      return null;",
      to: "        if (seen.size > 1) seen.set(k, e.seq);\n      }\n      return null;",
      refuted: ["atMostOnceMatchesReference"],
    },
    {
      bug: "repeated expected keys are reported once",
      file: "invariants.ts",
      from: ".filter((k) => !present.has(k));",
      to: ".filter((k, i, all) => !present.has(k) && all.indexOf(k) === i);",
      refuted: ["atLeastOnceMatchesReference"],
    },
    {
      bug: "everyRow fails a row only when it breaks every condition",
      file: "state.ts",
      from: "const failing = rows.filter((r) => !inv.holds.every((c) => rowMatches(r, c)));",
      to: "const failing = rows.filter((r) => !inv.holds.some((c) => rowMatches(r, c)));",
      refuted: ["everyRowMatchesReference"],
    },
    {
      bug: "neq fails on a row without the column",
      file: "state.ts",
      from: "return v === undefined || !jsonEqual(v, condition.value);",
      to: "return v !== undefined && !jsonEqual(v, condition.value);",
      refuted: ["everyRowMatchesReference"],
    },
    {
      bug: "unique counts null values",
      file: "state.ts",
      from: "    if (v === undefined || v === null) continue;\n    const k = canonicalJson(v);\n    counts.set",
      to: "    if (v === undefined) continue;\n    const k = canonicalJson(v);\n    counts.set",
      refuted: ["uniqueMatchesReference"],
    },
    {
      bug: "implies reports a missing key once per effect",
      file: "state.ts",
      from: "if (!missing.includes(k)) missing.push(k);",
      to: "missing.push(k);",
      refuted: ["impliesMatchesReference"],
    },
    {
      bug: "references reads the referring rows' target for both",
      file: "state.ts",
      from: "const targets = queryRows(log, inv.in);",
      to: "const targets = queryRows(log, { ...inv.in, target: inv.query.target });",
      refuted: ["referencesMatchesReference"],
    },
    {
      bug: "refines takes a decision that threw for one",
      file: "refines.ts",
      from: 'e.target === target && e.kind === "result" && getPath(e.payload, "error") === undefined,',
      to: 'e.target === target && e.kind === "result",',
      refuted: ["refinesMatchesReference"],
    },
    {
      bug: "refines counts the invocation's own write as stale",
      file: "refines.ts",
      from: "e.invocation !== effect.invocation &&",
      to: "",
      refuted: ["refinesOnStateMatchesReference"],
    },
    {
      bug: "refines ignores the key a write touches",
      file: "refines.ts",
      from: "(state.key === undefined || keyOf(e, state.key) === key),",
      to: "true,",
      refuted: ["refinesOnStateMatchesReference"],
    },
  ])(
    "a planted bug is refuted: $bug",
    ({ file, from, to, refuted }) => {
      const probe = join(root, "packages/core", `.probe-self-check-${process.pid}`);
      cpSync(join(root, "packages/core/src"), probe, { recursive: true });
      try {
        const path = join(probe, file);
        const source = readFileSync(path, "utf8");
        expect(source, "the planted bug's anchor").toContain(from);
        writeFileSync(path, source.replace(from, to));
        const r = report(probe);
        expect(r.status).toBe(1);
        const kinds = Object.fromEntries(r.report.specs.map((s) => [s.property, s.kind]));
        for (const p of refuted) expect(kinds[p], p).toBe("REFUTED");
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
