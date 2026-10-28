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
import type { Fn, Forall, FunctionSpec, Property } from "@eutaxy/spec";
import { evaluate, malformedReason, render } from "./checked.ts";
import {
  CannotGenerate,
  edgeAssignment,
  edgeAssignmentCount,
  edgeLists,
  generateAssignment,
} from "./generate.ts";
import { shrinkRefutation } from "./shrink.ts";

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
  // Every edge assignment is tried, however many there are (a union of a hundred literals has a
  // hundred); then random draws until the budget is met, and at least half of it random, so many
  // edges never crowd out the values between them.
  const edges = edgeLists(binders);
  const edgeTotal = edgeAssignmentCount(edges);
  const randomWanted = Math.ceil(wanted / 2);
  let randomHeld = 0;
  for (
    let draws = 0;
    draws < edgeTotal ||
    ((held < wanted || randomHeld < randomWanted) && draws < edgeTotal + wanted * 20);
    draws++
  ) {
    let values: unknown[];
    try {
      // The edges first, every one of them, then random draws.
      [values, state] =
        (draws < edgeTotal ? edgeAssignment(binders, edges, draws, state) : undefined) ??
        generateAssignment(binders, state);
    } catch (err) {
      if (err instanceof CannotGenerate) return unknown(err.why, err.message);
      throw err;
    }
    const key = values.map(render).join(", ");
    if (seen.has(key)) continue;
    seen.add(key);
    const result = evaluate(spec, values, true);
    if ("malformed" in result) return unknown("unsupported", malformedReason(result.malformed));
    if (result.outcome === "discarded") {
      discarded++;
      continue;
    }
    if (result.outcome === "refuted") {
      const smallest = shrinkRefutation(spec, binders, values, result);
      return {
        ...base,
        kind: "REFUTED",
        rung: "TESTED",
        counterexample: counterexample(smallest.values, smallest.error),
        assumptions: [`found on an input generated with seed ${input.seed}, then shrunk`],
      };
    }
    held++;
    if (draws >= edgeTotal) randomHeld++;
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
