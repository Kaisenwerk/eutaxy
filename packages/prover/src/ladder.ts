/**
 * The spec ladder, as far as it goes without an engine: `CHECKED` on the
 * inputs the simulator passed, then `TESTED` on generated ones. A
 * counterexample at either rung is `REFUTED`; otherwise the verdict is the
 * highest rung that decided, with the lower one's evidence kept beside it.
 */

import type { SpecVerdict } from "@eutaxy/core";
import { type Fn, type Forall, isSpec, type ModuleSpecs } from "@eutaxy/spec";
import { type CheckedInput, checkedRung, malformedReason } from "./checked.ts";
import { type TestedOptions, testedRung } from "./tested.ts";

export interface LadderOptions {
  /** Run the `TESTED` rung with these options; `false` stops the ladder at `CHECKED`. */
  readonly tested?: TestedOptions | false;
}

/** One property through the ladder's rungs. */
export function specLadder(input: CheckedInput, options: LadderOptions = {}): SpecVerdict {
  const checked = checkedRung(input);
  if (checked.kind === "REFUTED" || options.tested === false || options.tested === undefined)
    return checked;
  if (input.property.kind === "total") return checked;
  // A property that could not be evaluated on an input the simulator passed is malformed: sampling
  // that happens to miss the input must not make it look sound.
  if (checked.kind === "UNKNOWN" && checked.reason.startsWith(malformedReason(""))) return checked;
  const tested = testedRung({
    module: input.module,
    fn: input.fn,
    property: input.property,
    spec: input.spec,
    ...options.tested,
  });
  if (tested.kind === "REFUTED") return tested;
  // The same holds the other way round: a generated input that shows the property malformed outranks CHECKED.
  if (tested.kind === "UNKNOWN" && tested.reason.startsWith(malformedReason(""))) return tested;
  if (tested.kind === "TESTED") {
    if (checked.kind !== "CHECKED")
      // Why there is no `checked` count stays visible: the simulator never called the function, say.
      return { ...tested, assumptions: [...tested.assumptions, reason(checked)] };
    return {
      ...tested,
      checked: checked.inputs,
      assumptions: [...tested.assumptions, ...checked.assumptions],
    };
  }
  if (checked.kind !== "UNKNOWN")
    return { ...checked, assumptions: [...checked.assumptions, `not TESTED: ${reason(tested)}`] };
  // Neither rung decided: say why for both, once when it is the same reason.
  if (reason(tested) === checked.reason) return checked;
  return { ...checked, reason: `${checked.reason}; generated inputs: ${reason(tested)}` };
}

function reason(v: SpecVerdict): string {
  return v.kind === "UNKNOWN" ? v.reason : v.kind;
}

/**
 * Every spec verdict for one module: each property through the ladder.
 * `props` is the spec file's namespace, `namespace` the module's (after
 * observation ended, so it holds the functions themselves); a spec whose
 * function is not the module's export of that name is not evaluated.
 */
export function checkSpecModule(
  module: string,
  specs: ModuleSpecs,
  props: Readonly<Record<string, unknown>>,
  namespace: Readonly<Record<string, unknown>>,
  observed: {
    readonly calls: readonly { readonly function: string; readonly args: readonly unknown[] }[];
    readonly unobservable: { readonly [fn: string]: string };
  },
  options: LadderOptions = {},
): SpecVerdict[] {
  return specs.functions.flatMap((fn) => {
    const calls = observed.calls.filter((c) => c.function === fn.name);
    // Own properties only: a function named toString must not find Object.prototype's.
    const unobservable = Object.hasOwn(observed.unobservable, fn.name)
      ? observed.unobservable[fn.name]
      : undefined;
    return fn.properties.map((property) => {
      const exported = Object.hasOwn(props, property.name) ? props[property.name] : undefined;
      let spec: Forall<Fn> | undefined;
      let mismatch: string | undefined;
      if (!isSpec(exported)) mismatch = `the spec file exports no spec named ${property.name}`;
      else if (exported.fn !== namespace[fn.name])
        mismatch = `${property.name} names a function that is not the module's export ${fn.name}`;
      else if (exported.kind === "forall") spec = exported;
      if (mismatch !== undefined)
        return {
          module,
          function: fn.name,
          property: property.name,
          text: property.text,
          kind: "UNKNOWN",
          cause: "unavailable",
          reason: mismatch,
          assumptions: [],
        };
      return specLadder(
        {
          module,
          fn,
          property,
          calls,
          spec,
          ...(unobservable === undefined ? {} : { unobservable }),
        },
        options,
      );
    });
  });
}
