/**
 * A refuting assignment made as small as the candidates allow, one binder
 * at a time, while the property still fails: what the TESTED rung reports,
 * and what an engine reports after replaying a solver's model.
 */

import type { Binder, Fn, Forall } from "@eutaxy/spec";
import { type Evaluation, evaluate } from "./checked.ts";
import { shrinkCandidates } from "./generate.ts";

/** How many evaluations shrinking may spend on one counterexample. */
const shrinkBudget = 500;

export function shrinkRefutation(
  spec: Forall<Fn>,
  binders: readonly Binder[],
  start: readonly unknown[],
  startEvaluation: Evaluation,
): { readonly values: readonly unknown[]; readonly error?: string } {
  let values = [...start];
  let error: { readonly error?: string } = refutes(startEvaluation) ?? {};
  let spent = 0;
  let progress = true;
  while (progress && spent < shrinkBudget) {
    progress = false;
    for (let i = 0; i < binders.length && spent < shrinkBudget; i++) {
      const b = binders[i] as Binder;
      let moved = true;
      while (moved && spent < shrinkBudget) {
        moved = false;
        for (const candidate of shrinkCandidates(b, values[i])) {
          if (spent >= shrinkBudget) break;
          spent++;
          const trial = values.with(i, candidate);
          const still = refutes(evaluate(spec, trial, true));
          if (still === undefined) continue;
          values = trial;
          error = still;
          moved = true;
          progress = true;
          break;
        }
      }
    }
  }
  return error.error === undefined ? { values } : { values, error: error.error };
}

/** Whether an evaluation still refutes: an object (holding the error text, if any), or undefined. */
export function refutes(e: Evaluation): { readonly error?: string } | undefined {
  if ("malformed" in e || e.outcome !== "refuted") return undefined;
  return "error" in e && e.error !== undefined ? { error: e.error } : {};
}
