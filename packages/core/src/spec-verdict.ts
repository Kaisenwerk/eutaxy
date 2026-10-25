/**
 * Spec verdicts: what is known about one property of one pure function.
 * Kept apart from scenario verdicts in every report. The ladder runs
 * `CHECKED` (held on every input the simulator passed), then `TESTED` (held
 * on inputs generated from the binders' domains); `PROVEN` comes with the
 * provers.
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

/** The property held on inputs generated from its binders' domains, and on the simulator's where it passed any. */
export interface Tested extends SpecVerdictBase {
  readonly kind: "TESTED";
  /** Generated assignments the property held on. */
  readonly inputs: number;
  /** Generated assignments outside the claim: a precondition failed. */
  readonly discarded: number;
  /** The seed the assignments were drawn from; the same seed draws the same assignments. */
  readonly seed: string;
  /** Distinct inputs the simulator passed that the property also held on, when it passed any. */
  readonly checked?: number;
}

/** One assignment that breaks the property, as JavaScript literals, and where it came from. */
export interface Counterexample {
  /** In the property's binder order. */
  readonly binders: readonly { readonly name: string; readonly value: string }[];
  /** The simulator's call the assignment was taken from; absent when it was generated. */
  readonly call?: string;
  /** Set when evaluating the property threw instead of returning false. */
  readonly error?: string;
}

export interface Refuted extends SpecVerdictBase {
  readonly kind: "REFUTED";
  /** The rung that found the counterexample. */
  readonly rung: "CHECKED" | "TESTED";
  readonly counterexample: Counterexample;
}

export type SpecUnknownCause = "gave_up" | "unsupported" | "unavailable";

export interface SpecUnknown extends SpecVerdictBase {
  readonly kind: "UNKNOWN";
  readonly cause: SpecUnknownCause;
  readonly reason: string;
}

export type SpecVerdict = Checked | Tested | Refuted | SpecUnknown;

/** One line per spec verdict, for error messages; full rendering lives in `report`. */
export function describeSpecVerdict(v: SpecVerdict): string {
  const what = `${v.function} ${v.property}`;
  switch (v.kind) {
    case "CHECKED":
      return `CHECKED ${what}: held on ${v.inputs} input(s) the simulator passed`;
    case "TESTED":
      return `TESTED ${what}: held on ${v.inputs} generated input(s)`;
    case "REFUTED": {
      const c = v.counterexample;
      const where = c.call ?? c.binders.map((b) => `${b.name} = ${b.value}`).join(", ");
      return `REFUTED ${what}: ${where}${c.error ? ` threw ${c.error}` : ""}`;
    }
    case "UNKNOWN":
      return `UNKNOWN ${what}: ${v.cause}: ${v.reason}`;
  }
}
