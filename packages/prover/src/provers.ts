/**
 * The `Prover` interface every engine implements, first-party or not, and
 * the aggregation of what engines say into the ladder's verdicts. An
 * engine takes a module's source with its specs and the functions to
 * prove and answers per property: `PROVEN` with its name, version and
 * assumptions, or `UNKNOWN` as `gave_up` (a proof did not close, or timed
 * out), `unsupported` (outside its subset) or `unavailable` (not
 * installed). An engine that refutes gives `REFUTED` with a counterexample
 * when it has one. Engines run over a process boundary; nothing here
 * spawns anything.
 */

import type { Counterexample, SpecVerdict } from "@eutaxy/core";
import type { ModuleSpecs, SpecError } from "@eutaxy/spec";

export interface EngineId {
  readonly name: string;
  readonly version: string;
}

export type ProofOutcome =
  | { readonly kind: "PROVEN"; readonly engine: EngineId; readonly assumptions: readonly string[] }
  | {
      readonly kind: "REFUTED";
      readonly engine: EngineId;
      readonly counterexample?: Counterexample;
      readonly assumptions: readonly string[];
    }
  | {
      readonly kind: "UNKNOWN";
      readonly cause: "gave_up" | "unsupported" | "unavailable";
      readonly reason: string;
    };

export interface PropertyProof {
  readonly function: string;
  /** The property's export name in the spec file. */
  readonly property: string;
  readonly outcome: ProofOutcome;
}

export interface ModuleProofs {
  readonly results: readonly PropertyProof[];
  /** Specs that did not read: properties asked for and never checked. */
  readonly specErrors: readonly SpecError[];
}

export interface ProveInput {
  /** The module's source text. */
  readonly source: string;
  /** The module's specs, read from its spec file. */
  readonly specs: ModuleSpecs;
  /** The functions to prove; every one with specs when omitted. */
  readonly functions?: readonly string[];
  readonly timeoutMs?: number;
}

export interface Prover {
  readonly name: string;
  /** Whether the engine can run here, or why not. */
  available(): Promise<{ readonly version: string } | { readonly unavailable: string }>;
  prove(input: ProveInput): Promise<ModuleProofs>;
}

/** What an engine said about one module, by its name. */
export interface EngineReport {
  readonly engine: string;
  readonly proofs: ModuleProofs;
}

/**
 * The simulator's verdicts for a module (CHECKED, TESTED, REFUTED, UNKNOWN,
 * `total` included) combined with what the engines proved. A simulator
 * counterexample stands. One engine proving is `PROVEN`, the lower rungs'
 * counts kept beside it; an engine refuting where nothing else did is
 * `REFUTED` at the PROVEN rung; one proving and another refuting is
 * `CONFLICT`. An engine that gave up, could not run or does not take the
 * function leaves the verdict as it was, with why among the assumptions.
 */
export function aggregate(
  module: string,
  verdicts: readonly SpecVerdict[],
  reports: readonly EngineReport[],
): SpecVerdict[] {
  return verdicts.map((v) => {
    if (v.module !== module) return v;
    const says = reports
      .map((r) => ({
        engine: r.engine,
        outcome: r.proofs.results.find(
          (p) => p.function === v.function && p.property === v.property,
        )?.outcome,
      }))
      .filter((x): x is { engine: string; outcome: ProofOutcome } => x.outcome !== undefined);
    if (says.length === 0) return v;
    const proven = says.find((x) => x.outcome.kind === "PROVEN");
    const refuted = says.find((x) => x.outcome.kind === "REFUTED");
    if (v.kind === "REFUTED" || v.kind === "CONFLICT") {
      // The simulator's counterexample is a fact; an engine proving against it is a conflict too.
      if (v.kind === "REFUTED" && proven?.outcome.kind === "PROVEN")
        return {
          module: v.module,
          function: v.function,
          property: v.property,
          text: v.text,
          kind: "CONFLICT",
          proven: proven.outcome.engine,
          refuted: { name: "simulator", version: v.rung, counterexample: v.counterexample },
          assumptions: [...v.assumptions, ...proven.outcome.assumptions],
        };
      return v;
    }
    if (proven?.outcome.kind === "PROVEN" && refuted?.outcome.kind === "REFUTED")
      return {
        module: v.module,
        function: v.function,
        property: v.property,
        text: v.text,
        kind: "CONFLICT",
        proven: proven.outcome.engine,
        refuted: {
          name: refuted.outcome.engine.name,
          version: refuted.outcome.engine.version,
          ...(refuted.outcome.counterexample
            ? { counterexample: refuted.outcome.counterexample }
            : {}),
        },
        assumptions: [...proven.outcome.assumptions, ...refuted.outcome.assumptions],
      };
    if (refuted?.outcome.kind === "REFUTED")
      return {
        module: v.module,
        function: v.function,
        property: v.property,
        text: v.text,
        kind: "REFUTED",
        rung: "PROVEN",
        engine: refuted.outcome.engine,
        counterexample: refuted.outcome.counterexample ?? { binders: [] },
        assumptions: refuted.outcome.assumptions,
      };
    if (proven?.outcome.kind === "PROVEN")
      return {
        module: v.module,
        function: v.function,
        property: v.property,
        text: v.text,
        kind: "PROVEN",
        engine: proven.outcome.engine,
        ...(v.kind === "TESTED" ? { tested: v.inputs } : {}),
        ...(v.kind === "TESTED" && v.checked !== undefined
          ? { checked: v.checked }
          : v.kind === "CHECKED"
            ? { checked: v.inputs }
            : {}),
        assumptions: [...proven.outcome.assumptions, ...v.assumptions],
      };
    // Every engine fell short: say so beside the verdict that stands.
    const notes = says.map((x) =>
      x.outcome.kind === "UNKNOWN"
        ? `not PROVEN by ${x.engine}: ${x.outcome.cause}: ${x.outcome.reason}`
        : `${x.engine}: ${x.outcome.kind}`,
    );
    return { ...v, assumptions: [...v.assumptions, ...notes] };
  });
}
