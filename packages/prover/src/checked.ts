/**
 * The `CHECKED` rung: a property evaluated on every input the simulator
 * actually passed to its function. Binders are the function's parameters,
 * so each recorded call is one assignment; one failing the precondition is
 * outside the claim and discarded. One assignment where the claim is false
 * refutes the property. Holding on all of them is `CHECKED`, which says
 * nothing about inputs the simulator never passed.
 */

import type { Counterexample, SpecVerdict } from "@eutaxy/core";
import type { Fn, Forall, FunctionSpec, Property } from "@eutaxy/spec";
import { conforms } from "./generate.ts";
import { copy, render } from "./render.ts";

export { render } from "./render.ts";

/** What evaluating a spec on one assignment came to. */
export type PredicateOutcome = "held" | "discarded" | "refuted";

export type Evaluation =
  | { readonly outcome: "held" | "discarded" }
  | { readonly outcome: "refuted"; readonly error?: string }
  /** The property, not the function, is at fault: it cannot be evaluated at any rung. */
  | { readonly malformed: string };

/**
 * One assignment through a spec. The precondition decides whether the
 * assignment is inside the claim; a precondition that throws or does not
 * answer a boolean is a malformed property, since it cannot tell. The
 * claim then holds, or is false, or throws: a throw from the claim, the
 * function's own included, means the claim is not true there. A claim
 * that returns something other than a boolean is malformed.
 */
export function evaluate(
  spec: Forall<Fn>,
  values: readonly unknown[],
  /** For generated inputs: each arrow gets its own copy of their plain data (`copy`). */
  copied = false,
): Evaluation {
  const fresh = (): never[] => (copied ? copy(values) : values) as never[];
  if (spec.when) {
    let inside: unknown;
    try {
      inside = spec.when(...fresh());
    } catch (err) {
      return { malformed: `the precondition threw ${String(err)}` };
    }
    if (typeof inside !== "boolean")
      return { malformed: `the precondition returned ${render(inside)}, not a boolean` };
    if (!inside) return { outcome: "discarded" };
  }
  let claim: unknown;
  try {
    claim = spec.ensures(...fresh());
  } catch (err) {
    return { outcome: "refuted", error: String(err) };
  }
  if (typeof claim !== "boolean")
    return { malformed: `the claim returned ${render(claim)}, not a boolean` };
  return { outcome: claim ? "held" : "refuted" };
}

/** How every rung words an `UNKNOWN` for a property that cannot be evaluated; the ladder recognizes it. */
export const malformedReason = (detail: string): string =>
  `the property could not be evaluated: ${detail}`;

export interface CheckedInput {
  readonly module: string;
  readonly fn: FunctionSpec;
  readonly property: Property;
  /** The calls the simulator made, with their arguments. */
  readonly calls: readonly { readonly args: readonly unknown[] }[];
  /** The spec file's export, or undefined when it could not be loaded. */
  readonly spec: Forall<Fn> | undefined;
  /** Why the function's calls could not be observed, when they could not. */
  readonly unobservable?: string;
}

export function checkedRung(input: CheckedInput): SpecVerdict {
  const { module, fn, property } = input;
  const base = { module, function: fn.name, property: property.name, text: property.text };
  const unknown = (
    cause: "gave_up" | "unsupported" | "unavailable",
    reason: string,
  ): SpecVerdict => ({ ...base, kind: "UNKNOWN", cause, reason, assumptions: [] });
  if (property.kind === "total")
    return unknown(
      "unsupported",
      "termination is not observable on the inputs the simulator passed; total needs a prover",
    );
  if (input.unobservable)
    return unknown(
      "unavailable",
      `calls to ${fn.name} could not be observed: ${input.unobservable}`,
    );
  const spec = input.spec;
  if (!spec)
    return unknown("unavailable", `the spec file's export ${property.name} was not loaded`);
  const binders = property.binders;
  const seen = new Set<string>();
  let held = 0;
  let discarded = 0;
  for (const call of input.calls) {
    const values = binders.map((_, i) => call.args[i]);
    const key = values.map(render).join(", ");
    if (seen.has(key)) continue;
    seen.add(key);
    // The claim quantifies over the parameter types; a call with an argument of another type
    // (a shell passing a string where a number is declared) is outside it, not a counterexample.
    if (!binders.every((b, i) => conforms(b.type, values[i]))) {
      discarded++;
      continue;
    }
    const counterexample = (error?: string): Counterexample => ({
      binders: binders.map((b, i) => ({ name: b.name, value: render(values[i]) })),
      call: `${fn.name}(${call.args.map(render).join(", ")})`,
      ...(error === undefined ? {} : { error }),
    });
    const result = evaluate(spec, values);
    if ("malformed" in result) return unknown("unsupported", malformedReason(result.malformed));
    if (result.outcome === "refuted")
      return {
        ...base,
        kind: "REFUTED",
        rung: "CHECKED",
        counterexample: counterexample(result.error),
        assumptions: [],
      };
    if (result.outcome === "discarded") discarded++;
    else held++;
  }
  if (held === 0)
    return unknown(
      "gave_up",
      input.calls.length === 0
        ? `the simulator never called ${fn.name}`
        : `none of the ${seen.size} distinct input(s) the simulator passed is inside the claim (the precondition)`,
    );
  return {
    ...base,
    kind: "CHECKED",
    inputs: held,
    discarded,
    assumptions: [
      `held on the ${held} distinct input(s) the simulator passed to ${fn.name}; inputs it never passed are not covered`,
    ],
  };
}
