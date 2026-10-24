/**
 * Rendering verdicts: a text form for people and a versioned JSON form for
 * CI and coding agents. Both are pure functions over the verdict data.
 */

import {
  canonicalJson,
  type EffectLog,
  type JsonValue,
  type ScenarioVerdict,
  type SpecVerdict,
} from "@eutaxy/core";

export const reportSchemaVersion = 1;

/**
 * The JSON report: one object, canonical, with a schema version at the top.
 * Spec verdicts, when there are any, sit beside the scenario's, never in it.
 */
export function renderJson(verdict: ScenarioVerdict, specs: readonly SpecVerdict[] = []): string {
  return canonicalJson({
    schemaVersion: reportSchemaVersion,
    generator: "eutaxy",
    verdict: verdict as unknown as JsonValue,
    ...(specs.length > 0 ? { specs: specs as unknown as JsonValue } : {}),
  });
}

/** Spec verdicts as text: one line each, a counterexample under a refutation. */
export function renderSpecs(specs: readonly SpecVerdict[]): string {
  if (specs.length === 0) return "";
  const out = ["Specs (CHECKED means held on the inputs the simulator passed; it is not a proof)"];
  for (const v of specs) {
    const what = `${v.function} ${v.property}`;
    switch (v.kind) {
      case "CHECKED":
        out.push(
          `  CHECKED  ${what}: held on ${v.inputs} input(s)${v.discarded > 0 ? `, ${v.discarded} outside the claim` : ""}`,
        );
        break;
      case "REFUTED": {
        const c = v.counterexample;
        out.push(
          `  REFUTED  ${what}: false at ${c.call}${c.error ? `, which threw ${c.error}` : ""}`,
        );
        out.push(`           ${c.binders.map((b) => `${b.name} = ${b.value}`).join(", ")}`);
        out.push(`           ${v.text.replace(/\s+/g, " ")}`);
        break;
      }
      case "UNKNOWN":
        out.push(`  UNKNOWN  ${what}: ${v.cause}: ${v.reason}`);
        break;
    }
  }
  return out.join("\n");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** The trace as a fixed-width table; evidence rows are marked with `*`. */
export function renderTrace(log: EffectLog, evidence: readonly number[] = []): string {
  const rows = log.entries.map((e) => [
    evidence.includes(e.seq) ? "*" : " ",
    String(e.seq),
    e.invocation,
    e.kind,
    e.target,
    e.op,
    clip(canonicalJson(e.payload), 72),
  ]);
  const header = [" ", "seq", "invocation", "kind", "target", "op", "payload"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] as number)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** A readable report: verdict, what it rests on, and for a violation the schedule and trace. */
export function renderText(verdict: ScenarioVerdict): string {
  const out: string[] = [];
  const r = verdict.reached;
  out.push(`${verdict.kind}  ${verdict.scenario}  (seed ${String(verdict.seed)})`);
  switch (verdict.kind) {
    case "VIOLATED": {
      out.push("");
      out.push(
        `Invariant ${verdict.violation.invariant} is violated: ${verdict.violation.message}`,
      );
      out.push(`Keys: ${verdict.violation.keys.join(", ")}`);
      out.push("");
      out.push(
        `Schedule (run seed ${verdict.schedule.seed}), events kept: ${verdict.keptEvents.join(", ")}`,
      );
      if (verdict.schedule.faults.length === 0) out.push("  no injected faults");
      for (const f of verdict.schedule.faults) {
        out.push(`  ${f.fault} at ${f.invocation} effect #${f.ordinal} (${f.target} ${f.op})`);
      }
      out.push(
        `Shrunk: ${verdict.shrunk.eventsRemoved} event(s) and ${verdict.shrunk.faultsRemoved} fault(s) removed in ${verdict.shrunk.runs} run(s)`,
      );
      out.push("");
      out.push("Trace:");
      out.push(renderTrace(verdict.trace, verdict.violation.evidence));
      break;
    }
    case "BOUNDED": {
      const b = verdict.bounds;
      out.push("");
      out.push("No violation found within the stated bounds. This is not a proof.");
      out.push(
        `Bounds: faults per run ≤ ${b.maxFaultsPerRun}, redeliveries ≤ ${b.maxRedeliveries}, concurrent invocations ≤ ${b.maxConcurrentInvocations}, budget ${b.budgetMs} ms`,
      );
      break;
    }
    case "UNSUPPORTED": {
      out.push("");
      out.push(`Eutaxy could not decide this scenario (${verdict.cause}): ${verdict.reason}`);
      break;
    }
  }
  out.push("");
  out.push(
    `Explored: ${r.runs} run(s), ${r.effectPoints} effect point(s), ${r.faultsInjected} fault(s) injected, ${r.elapsedMs} ms`,
  );
  const e = r.exhaustive;
  if (e) {
    const stopped = {
      VIOLATED: "stopped at the first violation",
      BOUNDED: "stopped at the budget before every schedule ran",
      UNSUPPORTED: "stopped where the scenario could not be decided",
    }[verdict.kind];
    out.push(
      `Exhaustive: ${e.complete ? "every schedule within the bounds ran" : stopped} (${e.schedules} schedules${e.reduction ? ", partial-order reduction" : ""})`,
    );
  }
  out.push("Assumptions:");
  for (const a of verdict.assumptions) out.push(`  - ${a}`);
  return out.join("\n");
}
