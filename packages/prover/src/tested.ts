/**
 * The `TESTED` rung: a property evaluated on assignments drawn from its
 * binders' types, steered by the precondition's hints, with a seed, so the
 * same seed draws the same assignments everywhere. An assignment where the
 * claim is false is shrunk toward smaller values that still break it and
 * reported as a counterexample. Holding on every drawn assignment is
 * `TESTED`: evidence from sampling, which says nothing about the inputs
 * never drawn.
 */

import { type Counterexample, type PrngState, type SpecVerdict, seedPrng } from "@eutaxy/core";
import type { Binder, Fn, Forall, FunctionSpec, Property } from "@eutaxy/spec";
import { type Evaluation, evaluate, malformedReason, render } from "./checked.ts";
import { CannotGenerate, generateAssignment, shrinkCandidates } from "./generate.ts";

export interface TestedOptions {
  /** The check's seed; each property derives its own stream from it and its name. */
  readonly seed: string;
  /** Distinct assignments the property must hold on; default 100. Drawing stops after 20 times as many draws, whatever they were. */
  readonly inputs?: number;
}

export interface TestedInput extends TestedOptions {
  readonly module: string;
  readonly fn: FunctionSpec;
  readonly property: Property;
  /** The spec file's export, or undefined when it could not be loaded. */
  readonly spec: Forall<Fn> | undefined;
}

/** How many evaluations shrinking may spend on one counterexample. */
const shrinkBudget = 500;

export function testedRung(input: TestedInput): SpecVerdict {
  const { module, fn, property } = input;
  const base = { module, function: fn.name, property: property.name, text: property.text };
  const unknown = (
    cause: "gave_up" | "unsupported" | "unavailable",
    reason: string,
  ): SpecVerdict => ({ ...base, kind: "UNKNOWN", cause, reason, assumptions: [] });
  if (property.kind === "total")
    return unknown(
      "unsupported",
      "termination is not observable on generated inputs; total needs a prover",
    );
  const spec = input.spec;
  if (!spec)
    return unknown("unavailable", `the spec file's export ${property.name} was not loaded`);
  const binders = property.binders;
  const wanted = input.inputs ?? 100;
  if (!Number.isInteger(wanted) || wanted < 1)
    throw new RangeError(`inputs must be a positive integer, got ${String(input.inputs)}`);
  const seed = `${input.seed}:${module}:${fn.name}:${property.name}`;
  let state: PrngState = seedPrng(seed);
  let held = 0;
  let discarded = 0;
  // Distinct assignments only, as the CHECKED rung counts them: two booleans are two inputs, not a hundred.
  const seen = new Set<string>();
  const counterexample = (values: readonly unknown[], error?: string): Counterexample => ({
    binders: binders.map((b, i) => ({ name: b.name, value: render(values[i]) })),
    ...(error === undefined ? {} : { error }),
  });
  for (let draws = 0; held < wanted && draws < wanted * 20; draws++) {
    let values: unknown[];
    try {
      [values, state] = generateAssignment(binders, state);
    } catch (err) {
      if (err instanceof CannotGenerate) return unknown(err.why, err.message);
      throw err;
    }
    const key = values.map(render).join(", ");
    if (seen.has(key)) continue;
    seen.add(key);
    const result = evaluate(spec, values);
    if ("malformed" in result) return unknown("unsupported", malformedReason(result.malformed));
    if (result.outcome === "discarded") {
      discarded++;
      continue;
    }
    if (result.outcome === "refuted") {
      const smallest = shrink(spec, binders, values, result);
      return {
        ...base,
        kind: "REFUTED",
        rung: "TESTED",
        counterexample: counterexample(smallest.values, smallest.error),
        assumptions: [`found on an input generated with seed ${input.seed}, then shrunk`],
      };
    }
    held++;
  }
  if (held === 0)
    return unknown(
      "gave_up",
      `all ${discarded} distinct generated inputs were outside the claim: its precondition admits too few of the parameter types to sample`,
    );
  return {
    ...base,
    kind: "TESTED",
    inputs: held,
    discarded,
    seed: input.seed,
    assumptions: [
      `held on ${held} distinct input(s) generated from the parameter types with seed ${input.seed}; inputs never drawn are not covered`,
      `${fn.name} was called on generated inputs outside the simulator, so it is assumed pure`,
    ],
  };
}

/** The refuting assignment made as small as the candidates allow, one binder at a time. */
function shrink(
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
          const still = refutes(evaluate(spec, trial));
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
function refutes(e: Evaluation): { readonly error?: string } | undefined {
  if ("malformed" in e || e.outcome !== "refuted") return undefined;
  return "error" in e && e.error !== undefined ? { error: e.error } : {};
}
