/**
 * The self-check, v0.8's gate: `eutaxy report` on Eutaxy's own core holds
 * every invariant checker to its naive reference (each at CHECKED or
 * better), and would fail if a checker were wrong: each planted bug
 * below, made in a copy of the core's sources, is refuted. And the
 * enumeration model's claims are PROVEN by the Lean engine, with the
 * proofs supplied in schedules.props.lean (engine's tests hold the
 * enumerator to the model), and so are the delivery model's, the first
 * claims of v0.20's gate, with the proofs supplied in
 * delivery-model.props.lean (core's tests hold a loop over `redelivery`
 * to the model). The same holds of the Cloudflare platform's own rules,
 * the rest of that gate's claims: `eutaxy report` over its sources
 * reports the claims of the queue's decision rule and of the alarm's
 * rules PROVEN (the platform's tests hold its deliveries to them), and a
 * bug planted in each rule, in a copy of those sources, is refuted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eutaxyAsync, root } from "./eutaxy-command.ts";

interface Report {
  specs: { function: string; property: string; kind: string }[];
}

async function report(
  dir: string,
  args: readonly string[] = [],
): Promise<{ status: number; report: Report }> {
  const { status, stdout, stderr } = await eutaxyAsync(["report", dir, "--json", ...args]);
  try {
    return { status, report: JSON.parse(stdout) as Report };
  } catch {
    throw new Error(`eutaxy report ${dir} printed no report (exit ${status}):\n${stderr}`);
  }
}

/** Numbers each planted bug's copy of a package's sources, since they are made side by side. */
let copies = 0;

/** Whether the pinned Lean is installed: required where CI sets EUTAXY_REQUIRE_LEAN, and its tests skipped elsewhere. */
function leanInstalled(): boolean {
  const probe = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { findLean } from "./packages/prover-lean/src/index.ts"; const t = await findLean(); process.stdout.write("unavailable" in t ? "no" : "yes");',
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return probe.trim() === "yes";
}

const atLeastChecked = new Set(["CHECKED", "TESTED", "PROVEN"]);

// Every report runs in its own process on its own copy, so the tests run side by side.
describe.concurrent("the self-check", () => {
  test("every invariant checker agrees with its reference: CHECKED or better", async ({
    expect,
  }) => {
    const r = await report("packages/core/src");
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

  test("the enumeration model's claims and the delivery model's are PROVEN by the Lean engine, with supplied proofs", async ({
    expect,
  }) => {
    const hasLean = leanInstalled();
    if (!hasLean && process.env["EUTAXY_REQUIRE_LEAN"] !== "1") return;
    expect(hasLean, "the pinned Lean toolchain is required here").toBe(true);
    const r = await report("packages/core/src", ["--prover", "lean"]);
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
    const delivery = r.report.specs.filter((s) => s.function === "deliveries");
    expect(Object.fromEntries(delivery.map((s) => [s.property, s.kind]))).toEqual({
      withinTheLimits: "PROVEN",
      noneAfterHandled: "PROVEN",
      exactCount: "PROVEN",
    });
  }, 300_000);

  test("the claims of the queue's decision rule and of the alarm's rules are PROVEN by the Lean engine", async ({
    expect,
  }) => {
    const hasLean = leanInstalled();
    if (!hasLean && process.env["EUTAXY_REQUIRE_LEAN"] !== "1") return;
    expect(hasLean, "the pinned Lean toolchain is required here").toBe(true);
    const r = await report("packages/cloudflare/src", ["--prover", "lean"]);
    expect(r.status).toBe(0);
    // Every spec of the platform's sources is one of these rules' claims.
    expect(
      Object.fromEntries(r.report.specs.map((s) => [`${s.function} ${s.property}`, s.kind])),
    ).toEqual({
      "settled firstDecisionWins": "PROVEN",
      "settled acknowledgedOnCompletion": "PROVEN",
      "settled handledExactly": "PROVEN",
      "standingAfter onlyTheFirstTakesEffect": "PROVEN",
      "retryDelayMs backoffStartsAtTwoSeconds": "PROVEN",
      "retryDelayMs backoffDoubles": "PROVEN",
      "retryDelayMs lastRetryWaitsSixtyFourSeconds": "PROVEN",
      "generationAfter supersededByAnyChange": "PROVEN",
    });
  }, 300_000);

  // Under the package so the copy resolves @eutaxy/spec; .probe-* is gitignored. Each bug its own copy.
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
      from: "keys: [...missing],",
      to: "keys: selectEffects(log, inv.when).map((e) => keyOf(e, inv.key)).filter((k) => k !== undefined && missing.has(k)) as string[],",
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
      from: "for (let i = lastBelow(seq); i >= 0; i--) {",
      to: "for (let i = 0; i <= lastBelow(seq); i++) {",
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
      from: "(state.key === undefined || keyOf(e, state.key) === key)",
      to: "true",
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
    {
      bug: "the delivery model redelivers once more than the platform's limit allows",
      file: "delivery-model.ts",
      from: "return !(attempt - 1 >= limit || attempt - 1 >= maxRedeliveries);",
      to: "return !(attempt - 1 > limit || attempt - 1 >= maxRedeliveries);",
      refuted: ["withinTheLimits", "exactCount"],
    },
    {
      bug: "the delivery model delivers again after a delivery that was handled",
      file: "delivery-model.ts",
      from: "if ((handled[0] ?? true) || !redelivers(attempt, limit, maxRedeliveries)) return 1;",
      to: "if (!redelivers(attempt, limit, maxRedeliveries)) return 1;",
      refuted: ["noneAfterHandled", "exactCount"],
    },
    {
      bug: "the queue's rule lets the last decision win",
      pkg: "cloudflare",
      file: "queue-decision.ts",
      from: 'return standing === "none" ? call : standing;',
      to: "return call;",
      refuted: ["firstDecisionWins", "handledExactly"],
    },
    {
      bug: "the queue's rule acknowledges for a handler that did not complete",
      pkg: "cloudflare",
      file: "queue-decision.ts",
      from: 'return completed && standing === "none";',
      to: 'return standing === "none";',
      refuted: ["acknowledgedOnCompletion", "handledExactly"],
    },
    {
      bug: "the queue's rule takes a message nobody decided for handled",
      pkg: "cloudflare",
      file: "queue-decision.ts",
      from: 'return standing === "ack";',
      to: 'return standing !== "retry";',
      refuted: ["handledExactly"],
    },
    {
      bug: "the queue's rule lets every call take effect",
      pkg: "cloudflare",
      file: "queue-decision.ts",
      after: "export function takesEffect",
      from: 'return standing === "none";',
      to: "return true;",
      refuted: ["onlyTheFirstTakesEffect"],
    },
    {
      bug: "the alarm's backoff grows by two seconds instead of doubling",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "return firstRetryMs * doublings(retryCount);",
      to: "return firstRetryMs * (retryCount + 1);",
      refuted: ["backoffDoubles"],
    },
    {
      bug: "the alarm's first retry waits one second",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "const firstRetryMs = 2_000;",
      to: "const firstRetryMs = 1_000;",
      refuted: ["backoffStartsAtTwoSeconds"],
    },
    {
      bug: "the alarm is retried seven times, past the delays the backoff has",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "export const alarmRetries = 6;",
      to: "export const alarmRetries = 7;",
      refuted: ["backoffDoubles"],
    },
    {
      bug: "the alarm is retried five times, so its last retry waits half as long",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "export const alarmRetries = 6;",
      to: "export const alarmRetries = 5;",
      refuted: ["lastRetryWaitsSixtyFourSeconds"],
    },
    {
      bug: "an alarm set again keeps its generation, so the one it replaced still fires",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "return generation + 1;",
      to: "return generation;",
      refuted: ["supersededByAnyChange"],
    },
    {
      bug: "only an alarm from a later generation counts as superseded",
      pkg: "cloudflare",
      file: "alarm-rules.ts",
      from: "return generation !== current;",
      to: "return generation > current;",
      refuted: ["supersededByAnyChange"],
    },
  ])(
    "a planted bug is refuted: $bug",
    async ({
      pkg = "core",
      file,
      after,
      from,
      to,
      refuted,
    }: {
      pkg?: string;
      file: string;
      after?: string;
      from: string;
      to: string;
      refuted: string[];
    }) => {
      const probe = join(root, "packages", pkg, `.probe-self-check-${process.pid}-${copies++}`);
      cpSync(join(root, "packages", pkg, "src"), probe, { recursive: true });
      try {
        const path = join(probe, file);
        const source = readFileSync(path, "utf8");
        const at = source.indexOf(from, after === undefined ? 0 : source.indexOf(after));
        expect(at, "the planted bug's line").toBeGreaterThanOrEqual(0);
        writeFileSync(path, source.slice(0, at) + to + source.slice(at + from.length));
        const r = await report(probe);
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
