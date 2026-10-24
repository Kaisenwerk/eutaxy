/**
 * Spec verdicts: what is known about one property of one pure function.
 * Kept apart from scenario verdicts in every report. The ladder starts at
 * `CHECKED` (held on every input the simulator passed); `TESTED` and
 * `PROVEN` come with the provers.
 */

interface SpecVerdictBase {
  /** The module, as the scenario names it. */
  readonly module: string;
  readonly function: string;
  /** The `@ensures` name, or `@total` / `@throws` for those markers. */
  readonly property: string;
  /** The property as written. */
  readonly text: string;
  readonly assumptions: readonly string[];
}

export interface Checked extends SpecVerdictBase {
  readonly kind: "CHECKED";
  /** Distinct inputs the property was evaluated on. */
  readonly inputs: number;
  /** Distinct inputs outside the claim: a precondition failed, or a value fell outside its binder's domain. */
  readonly discarded: number;
}

/** One assignment that breaks the property, as JavaScript literals, and the call it came from. */
export interface Counterexample {
  /** In the property's binder order. */
  readonly binders: readonly { readonly name: string; readonly value: string }[];
  readonly call: string;
  /** Set when evaluating the property threw instead of returning false. */
  readonly error?: string;
}

export interface Refuted extends SpecVerdictBase {
  readonly kind: "REFUTED";
  readonly rung: "CHECKED";
  readonly counterexample: Counterexample;
}

export type SpecUnknownCause = "gave_up" | "unsupported" | "unavailable";

export interface SpecUnknown extends SpecVerdictBase {
  readonly kind: "UNKNOWN";
  readonly cause: SpecUnknownCause;
  readonly reason: string;
}

export type SpecVerdict = Checked | Refuted | SpecUnknown;

/** One line per spec verdict, for error messages; full rendering lives in `report`. */
export function describeSpecVerdict(v: SpecVerdict): string {
  const what = `${v.function} ${v.property}`;
  switch (v.kind) {
    case "CHECKED":
      return `CHECKED ${what}: held on ${v.inputs} input(s) the simulator passed`;
    case "REFUTED":
      return `REFUTED ${what}: ${v.counterexample.call}${v.counterexample.error ? ` threw ${v.counterexample.error}` : ""}`;
    case "UNKNOWN":
      return `UNKNOWN ${what}: ${v.cause}: ${v.reason}`;
  }
}
