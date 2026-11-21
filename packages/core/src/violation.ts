/** A violation: what a check of an invariant reports when it does not hold, and when two of them are the same one. */

/** An invariant that did not hold: its name, what went wrong, the keys involved and the effects that show it. */
export interface Violation {
  readonly invariant: string;
  readonly message: string;
  /** The keys involved, in canonical JSON, so two violations can be compared across runs. */
  readonly keys: readonly string[];
  /** Sequence numbers of the effects that witness the violation. */
  readonly evidence: readonly number[];
}

/** True when two violations are of the same invariant for the same keys, whatever the traces. */
export function sameViolation(a: Violation, b: Violation): boolean {
  return (
    a.invariant === b.invariant &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}
