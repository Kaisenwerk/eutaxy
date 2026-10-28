/**
 * The self-check, v0.8's gate: `eutaxy report` on Eutaxy's own core holds
 * every invariant checker to its naive reference (each at CHECKED or
 * better), and would fail if a checker were wrong: each planted bug
 * below, made in a copy of the core's sources, is refuted. And the
 * enumeration model's claims are PROVEN by the Lean engine, with the
 * proofs supplied in schedules.props.lean (engine's tests hold the
 * enumerator to the model).
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

function report(dir: string, args: readonly string[] = []): { status: number; report: Report } {
  let stdout: string;
  let stderr = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [bin, "report", dir, "--json", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
  }
  try {
    return { status, report: JSON.parse(stdout) as Report };
  } catch {
    throw new Error(`eutaxy report ${dir} printed no report (exit ${status}):\n${stderr}`);
  }
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
      "rowMatchesEach",
      "uniqueShared",
    ]);
    for (const s of checkers) expect(atLeastChecked.has(s.kind), s.property).toBe(true);
  }, 120_000);

  test("the enumeration model's claims are PROVEN by the Lean engine, with supplied proofs", () => {
    // Required where the pinned Lean is installed (CI sets EUTAXY_REQUIRE_LEAN); skipped elsewhere.
    const probe = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { findLean } from "./packages/prover-lean/src/index.ts"; const t = await findLean(); process.stdout.write("unavailable" in t ? "no" : "yes");',
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const hasLean = probe.trim() === "yes";
    if (!hasLean && process.env["EUTAXY_REQUIRE_LEAN"] !== "1") return;
    expect(hasLean, "the pinned Lean toolchain is required here").toBe(true);
    const r = report("packages/core/src", ["--prover", "lean"]);
    expect(r.status).toBe(0);
    const model = r.report.specs.filter((s) => s.function === "schedules");
    const kinds = Object.fromEntries(model.map((s) => [s.property, s.kind]));
    expect(kinds).toEqual({
      countIsProduct: "PROVEN",
      noRepeat: "PROVEN",
      inBounds: "PROVEN",
      // Held exactly on every tree up to a bound by engine's refinement test; its proof is not supplied.
      depthFirstOrder: "TESTED",
    });
  }, 300_000);

  // Under packages/core so the copy resolves @eutaxy/spec; .probe-* is gitignored.
  // Each bug is one line, found by its text (after `after`, when the line occurs more than once).
  test.each([
    {
      bug: "the selector ignores the effect kind",
      file: "selectors.ts",
      from: "if (sel.kind !== undefined && record.kind !== sel.kind) return false;",
      to: "",
      refuted: ["atMostOnceMatchesReference", "atLeastOnceMatchesReference"],
    },
    {
      bug: "the selector's lower bound is inverted",
      file: "selectors.ts",
      from: 'if (typeof v !== "number" || v < min) return false;',
      to: 'if (typeof v !== "number" || v > min) return false;',
      refuted: ["atMostOnceMatchesReference", "atLeastOnceMatchesReference"],
    },
    {
      bug: "atMostOncePerKey compares raw values, so the string 1 and the number 1 collide",
      file: "invariants.ts",
      from: "const k = keyOf(e, inv.key);",
      to: "const k = String(getPath(e.payload, inv.key));",
      refuted: ["atMostOnceMatchesReference"],
    },
    {
      bug: "atLeastOnce reports repeated expected keys once",
      file: "invariants.ts",
      from: ".filter((k) => !present.has(k));",
      to: ".filter((k, i, all) => !present.has(k) && all.indexOf(k) === i);",
      refuted: ["atLeastOnceMatchesReference"],
    },
    {
      bug: "atLeastOnce gives no evidence",
      file: "invariants.ts",
      from: "evidence: selected.map((e) => e.seq),",
      to: "evidence: [],",
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
      refuted: ["rowMatchesMatchesReference"],
    },
    {
      bug: "unique counts null values",
      file: "state.ts",
      after: "export function checkUnique",
      from: "if (v === undefined || v === null) continue;",
      to: "if (v === undefined) continue;",
      refuted: ["uniqueMatchesReference"],
    },
    {
      bug: "unique reads its path as a column, not a dot path",
      file: "state.ts",
      after: "export function checkUnique",
      from: "const v = getPath(r as JsonValue, inv.path);",
      to: "const v = r[inv.path];",
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
      bug: "implies ignores its state query's filter",
      file: "state.ts",
      from: "const rows = queryRows(log, inv.state);",
      to: "const rows = queryRows(log, { ...inv.state, where: [] });",
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
      bug: "refines carries out the earliest decision and rests on the earliest read",
      file: "refines.ts",
      from: "if (e.invocation === invocation && pick(e)) found = e;",
      to: "if (e.invocation === invocation && pick(e)) found ??= e;",
      refuted: ["refinesMatchesReference", "refinesOnStateMatchesReference"],
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
    {
      bug: "the model repeats the first option",
      file: "schedules.ts",
      from: "rest.map((s) => [i, ...s])",
      to: "rest.map((s) => [0, ...s])",
      refuted: ["depthFirstOrder"],
    },
    {
      bug: "the model drops the last option of every level",
      file: "schedules.ts",
      from: "return (levels[0] ?? []).flatMap(",
      to: "return (levels[0] ?? []).slice(1).flatMap(",
      refuted: ["countIsProduct"],
    },
  ])(
    "a planted bug is refuted: $bug",
    ({
      file,
      after,
      from,
      to,
      refuted,
    }: {
      file: string;
      after?: string;
      from: string;
      to: string;
      refuted: string[];
    }) => {
      const probe = join(root, "packages/core", `.probe-self-check-${process.pid}`);
      cpSync(join(root, "packages/core/src"), probe, { recursive: true });
      try {
        const path = join(probe, file);
        const source = readFileSync(path, "utf8");
        const at = source.indexOf(from, after === undefined ? 0 : source.indexOf(after));
        expect(at, "the planted bug's line").toBeGreaterThanOrEqual(0);
        writeFileSync(path, source.slice(0, at) + to + source.slice(at + from.length));
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
