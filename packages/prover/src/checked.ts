/**
 * The `CHECKED` rung: a property evaluated on every input the simulator
 * actually passed to its function. Binders are matched to the function's
 * parameters by name, so each recorded call is one assignment; a value
 * outside its binder's domain or guard, or one failing a precondition, is
 * outside the claim and discarded. One assignment where the claim is false
 * refutes the property. Holding on all of them is `CHECKED`, which says
 * nothing about inputs the simulator never passed.
 */

import type { Counterexample, SpecVerdict } from "@eutaxy/core";
import {
  type Binder,
  endpointNumber,
  type FunctionSpec,
  type ModuleSpecs,
  type NamedProperty,
  type PredicateOutcome,
} from "@eutaxy/spec";

/** Thrown by `lemmaBool` when an atom is not a genuine boolean: the property is malformed, not false. */
export class AtomNotBoolean extends TypeError {}

/** Thrown by `lemmaUnresolved`: the property names something neither its module nor the globals define. */
export class UnresolvedName extends ReferenceError {}

/** What generated predicates call when free names did not resolve. */
export function lemmaUnresolved(names: readonly string[]): never {
  throw new UnresolvedName(
    `the property refers to ${names.join(", ")}, which neither its module exports nor the globals define`,
  );
}

/** The atom check generated predicates call: its argument when it is a boolean. */
export function lemmaBool(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new AtomNotBoolean(`a Lemma atom evaluated to ${render(value)}, not a boolean`);
  return value;
}

/** A value as a JavaScript literal, exact for the binder domains. */
export function render(value: unknown): string {
  switch (typeof value) {
    case "bigint":
      return `${value}n`;
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "boolean":
      return String(value);
    case "function":
      return "[function]";
  }
  try {
    const text = JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

function bound(value: string, integral: boolean): number | bigint {
  if (integral && !value.endsWith("∞")) return BigInt(value.replace(/_/g, "").replace(/n$/, ""));
  return endpointNumber(value);
}

/** Whether a value lies in a binder's domain and guard. */
export function inDomain(b: Binder, v: unknown): boolean {
  switch (b.domain) {
    case "int":
      if (!(typeof v === "number" && Number.isInteger(v))) return false;
      break;
    case "nat":
      if (!(typeof v === "number" && Number.isInteger(v) && v >= 0)) return false;
      break;
    case "number":
      if (typeof v !== "number") return false;
      break;
    case "bigint":
      if (typeof v !== "bigint") return false;
      break;
    case "string":
      if (typeof v !== "string") return false;
      break;
    case "boolean":
      return typeof v === "boolean";
  }
  const g = b.guard;
  if (!g) return true;
  if (g.kind === "regex") return new RegExp(`^(?:${g.pattern})$`, g.flags).test(v as string);
  // Integer domains compare exactly: an integer double converts to bigint without loss.
  const integral = b.domain !== "number";
  const x = integral ? BigInt(v as number | bigint) : (v as number);
  const lo = bound(g.lower.value, integral);
  const hi = bound(g.upper.value, integral);
  const aboveLower = g.lower.inclusive ? x >= lo : x > lo;
  const belowUpper = g.upper.inclusive ? x <= hi : x < hi;
  return aboveLower && belowUpper;
}

export interface CheckedInput {
  readonly module: string;
  readonly fn: FunctionSpec;
  readonly property: NamedProperty;
  /** The calls the simulator made, with their arguments. */
  readonly calls: readonly { readonly args: readonly unknown[] }[];
  /** The compiled predicate over the binders, or undefined when it could not be built. */
  readonly predicate: ((...binders: never[]) => PredicateOutcome) | undefined;
  /** Why the function's calls could not be observed, when they could not. */
  readonly unobservable?: string;
}

export function checkedRung(input: CheckedInput): SpecVerdict {
  const { module, fn, property } = input;
  const base = { module, function: fn.name, property: property.name, text: property.text };
  const unknown = (
    cause: "gave_up" | "unsupported" | "unavailable",
    reason: string,
  ): SpecVerdict => ({
    ...base,
    kind: "UNKNOWN",
    cause,
    reason,
    assumptions: [],
  });
  if (input.unobservable)
    return unknown(
      "unavailable",
      `calls to ${fn.name} could not be observed: ${input.unobservable}`,
    );
  const predicate = input.predicate as ((...binders: unknown[]) => PredicateOutcome) | undefined;
  if (!predicate) return unknown("unavailable", "the property's predicate was not compiled");
  const binders = property.property.binders;
  const positions: number[] = [];
  for (const b of binders) {
    const at = fn.params.indexOf(b.name);
    if (at < 0)
      return unknown(
        "unsupported",
        `binder ${b.name} is not a parameter of ${fn.name}, so the inputs the simulator passed do not determine it`,
      );
    positions.push(at);
  }
  const seen = new Set<string>();
  let held = 0;
  let discarded = 0;
  for (const call of input.calls) {
    const values = positions.map((p) => call.args[p]);
    const key = values.map(render).join(", ");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!binders.every((b, i) => inDomain(b, values[i]))) {
      discarded++;
      continue;
    }
    const counterexample = (error?: string): Counterexample => ({
      binders: binders.map((b, i) => ({ name: b.name, value: render(values[i]) })),
      call: `${fn.name}(${call.args.map(render).join(", ")})`,
      ...(error === undefined ? {} : { error }),
    });
    let outcome: PredicateOutcome;
    try {
      outcome = predicate(...values);
    } catch (err) {
      // An atom that is not a boolean, or a name nothing defines, is a malformed property. Any other throw, the function's own
      // included (JSON.parse's SyntaxError, say), means the claim is not true there.
      // A ReferenceError, likewise: compiled TypeScript under test hardly throws one, a name the
      // property's scope analysis missed does, and that must never pass for a refutation.
      if (err instanceof AtomNotBoolean || err instanceof ReferenceError)
        return unknown("unsupported", `the property could not be evaluated: ${String(err)}`);
      return {
        ...base,
        kind: "REFUTED",
        rung: "CHECKED",
        counterexample: counterexample(String(err)),
        assumptions: [],
      };
    }

    if (outcome === "refuted")
      return {
        ...base,
        kind: "REFUTED",
        rung: "CHECKED",
        counterexample: counterexample(),
        assumptions: [],
      };
    if (outcome === "discarded") discarded++;
    else held++;
  }
  if (held === 0)
    return unknown(
      "gave_up",
      input.calls.length === 0
        ? `the simulator never called ${fn.name}`
        : `none of the ${seen.size} distinct input(s) the simulator passed is inside the claim (domains, guards, preconditions)`,
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

/** Verdicts for the markers the CHECKED rung cannot decide. */
export function markerVerdicts(module: string, fn: FunctionSpec): SpecVerdict[] {
  const out: SpecVerdict[] = [];
  const base = { module, function: fn.name, assumptions: [] };
  if (fn.total)
    out.push({
      ...base,
      property: "@total",
      text: "@total",
      kind: "UNKNOWN",
      cause: "unsupported",
      reason:
        "termination is not observable on the inputs the simulator passed; @total needs a prover",
    });
  if (fn.throws)
    out.push({
      ...base,
      property: "@throws",
      text: "@throws",
      kind: "UNKNOWN",
      cause: "unsupported",
      reason: "Lemma has not fixed what @throws claims yet",
    });
  return out;
}

/** Compiled predicates of a module, by function and property name. */
export interface ModulePredicates {
  readonly [fn: string]: { readonly [property: string]: (...binders: never[]) => PredicateOutcome };
}

/** Every spec verdict for one module, from what was observed of its calls. */
export function checkSpecModule(
  module: string,
  specs: ModuleSpecs,
  predicates: ModulePredicates,
  observed: {
    readonly calls: readonly { readonly function: string; readonly args: readonly unknown[] }[];
    readonly unobservable: { readonly [fn: string]: string };
  },
): SpecVerdict[] {
  return specs.functions.flatMap((fn) => {
    const calls = observed.calls.filter((c) => c.function === fn.name);
    // Own properties only: a function named toString must not find Object.prototype's.
    const unobservable = Object.hasOwn(observed.unobservable, fn.name)
      ? observed.unobservable[fn.name]
      : undefined;
    const own = Object.hasOwn(predicates, fn.name) ? predicates[fn.name] : undefined;
    return [
      ...fn.ensures.map((property) =>
        checkedRung({
          module,
          fn,
          property,
          calls,
          predicate: own && Object.hasOwn(own, property.name) ? own[property.name] : undefined,
          ...(unobservable === undefined ? {} : { unobservable }),
        }),
      ),
      ...markerVerdicts(module, fn),
    ];
  });
}
