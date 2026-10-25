/**
 * The `TESTED` rung: a property evaluated on assignments drawn from its
 * binders' domains and guards, with a seed, so the same seed draws the same
 * assignments everywhere. An assignment where the claim is false is shrunk
 * toward smaller values that still break it and reported as a
 * counterexample. Holding on every drawn assignment is `TESTED`: evidence
 * from sampling, which says nothing about the inputs never drawn.
 */

import { type Counterexample, type PrngState, type SpecVerdict, seedPrng } from "@eutaxy/core";
import type { FunctionSpec, NamedProperty, PredicateOutcome } from "@eutaxy/spec";
import { type Evaluation, evaluate, malformedReason, render } from "./checked.ts";
import { CannotGenerate, generate, shrinkCandidates } from "./generate.ts";

export interface TestedOptions {
  /** The check's seed; each property derives its own stream from it and its name. */
  readonly seed: string;
  /** Distinct assignments the property must hold on; default 100. Drawing stops after 20 times as many draws, whatever they were. */
  readonly inputs?: number;
}

export interface TestedInput extends TestedOptions {
  readonly module: string;
  readonly fn: FunctionSpec;
  readonly property: NamedProperty;
  /** The compiled predicate over the binders, or undefined when it could not be built. */
  readonly predicate: ((...binders: never[]) => PredicateOutcome) | undefined;
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
  const predicate = input.predicate as ((...binders: unknown[]) => PredicateOutcome) | undefined;
  if (!predicate) return unknown("unavailable", "the property's predicate was not compiled");
  const binders = property.property.binders;
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
    const values: unknown[] = [];
    try {
      for (const b of binders) {
        const [v, next] = generate(b, state);
        state = next;
        values.push(v);
      }
    } catch (err) {
      if (err instanceof CannotGenerate) return unknown("gave_up", err.message);
      throw err;
    }
    const key = values.map(render).join(", ");
    if (seen.has(key)) continue;
    seen.add(key);
    const result = evaluate(predicate, values);
    if ("malformed" in result) return unknown("unsupported", malformedReason(result.malformed));
    if (result.outcome === "discarded") {
      discarded++;
      continue;
    }
    if (result.outcome === "refuted") {
      const smallest = shrink(predicate, binders, values, result);
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
      `all ${discarded} distinct generated inputs were outside the claim: its preconditions admit too few of the binders' domains to sample`,
    );
  return {
    ...base,
    kind: "TESTED",
    inputs: held,
    discarded,
    seed: input.seed,
    assumptions: [
      `held on ${held} distinct input(s) generated from the binders' domains with seed ${input.seed}; inputs never drawn are not covered`,
      `${fn.name} was called on generated inputs outside the simulator, so it is assumed pure`,
    ],
  };
}

/** The refuting assignment made as small as the candidates allow, one binder at a time. */
function shrink(
  predicate: (...binders: unknown[]) => PredicateOutcome,
  binders: NamedProperty["property"]["binders"],
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
      const b = binders[i] as (typeof binders)[number];
      let moved = true;
      while (moved && spent < shrinkBudget) {
        moved = false;
        for (const candidate of shrinkCandidates(b, values[i])) {
          if (spent >= shrinkBudget) break;
          spent++;
          const trial = values.with(i, candidate);
          const still = refutes(evaluate(predicate, trial));
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
  return "error" in e ? { error: e.error } : {};
}
