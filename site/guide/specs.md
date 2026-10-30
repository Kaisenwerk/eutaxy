---
description: Write specs for the pure TypeScript core of a Cloudflare Worker with forall and total, check them on the inputs the simulation produced (CHECKED) and on generated inputs (TESTED), and run them all with eutaxy report.
---

# Specs

A Worker that keeps its decisions in pure functions (whether a refund may
go ahead, which lease is free, what the next state is) can have those
functions checked for every input, not just the ones a scenario happens to
reach. Eutaxy calls these properties **specs**.

## Spec files

Specs live in a spec file beside the module: `domain.ts` has
`domain.props.ts`. The spec file imports the module and `eutaxy/spec`, and
exports one property per named export.

```ts
// domain.ts
export interface RefundDecision {
  readonly ok: boolean;
  /** The refunded total after this decision. */
  readonly refunded: number;
}

export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount > captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
```

```ts
// domain.props.ts
import { forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";

export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(amount) && 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
```

Specs sit beside the module rather than in it, so the core still imports
nothing and the Worker's bundle carries no spec.

## `forall(f, { when, ensures, sample })`

Quantifies over the parameter types of `f`.
- `ensures` is the claim. Its parameters are `f`'s, typed by your own
  compiler, so a spec that no longer matches its function does not compile.
  The claim names the function by value, so renaming it cannot detach the
  spec.
- `when` is the optional precondition. Inputs failing it are outside the
  claim, and `ensures` is evaluated only where it holds, so a guard such as
  `c !== null` protects the reads after it.
- `sample` optionally limits the inputs the `TESTED` rung draws, where
  evaluating the claim on large inputs costs too much. It does not narrow
  the claim: the simulation's own inputs and the provers still cover every
  input, and the verdict names the sample.

A claim's body is ordinary TypeScript over the subset the engines read:
comparisons, `&& || !`, the conditional operator, field reads, and calls to
the module's functions.

### `number` is a double

`number` is drawn and modelled as JavaScript's IEEE double: `NaN`, the
infinities and `-0` are inputs like any other. A claim that holds only for
integers says so in `when` (`Number.isInteger(n)`, `0 <= n`). Without the
`Number.isInteger(amount)` guard above, `amount = NaN` gives a `NaN` total,
the claim is false, and Eutaxy says so (see [Provers](/guide/provers#when-engines-disagree)).

## `total(f)`

Claims that `f` terminates on every input. No sampling rung can decide
termination, so `total` is `UNKNOWN` until the Lean engine proves it.

## Binder types

A binder's domain is its parameter type, as your compiler resolves it:
`number`, `bigint`, `boolean`, `string`, unions of literals, records
(interfaces or object types, including inline ones and types imported from
other files), nullable types (`T | null`), tagged unions, arrays
(`T[]`, `readonly T[]`, `Array<T>`) and generic aliases instantiated.

## The ladder

Each property climbs a ladder of rungs. A counterexample at any rung is
`REFUTED` with the input that breaks it; a rung that cannot decide only
lowers the verdict.

### `CHECKED`: the simulation's own inputs

When a scenario lists the module in `specs`, every call into its functions
from outside the module is recorded while the scenario runs, and each
property is evaluated on each distinct recorded call. These are the inputs
your Worker actually produces under faults and interleavings, which is
where generated inputs are weakest. Core functions must be synchronous; one
that returns a promise makes the run `UNSUPPORTED`.

### `TESTED`: generated inputs

Then the property is evaluated on inputs drawn from the parameter types
with the seed, so the same seed draws the same inputs on every machine:
- **Edges first.** Every binder's edge values (range ends, zero and one,
  `NaN`, the infinities, `-0`, the empty string, both booleans, every
  member of a union, the empty array) are tried before any random draw.
- **Then random draws**, biased the way bugs are distributed: mostly small
  integers, some large ones, fractions and special doubles, short strings,
  short arrays with repeated elements.
- **Steered by `when`.** Comparisons with constants (`0 <= n`) steer draws
  into range, and later integer binders are sometimes drawn equal to an
  earlier one or to a sum or difference of two, so relational
  preconditions are met rather than missed. A string tested against a
  whole-string regex in `when` is drawn by walking the pattern.
- **Shrunk.** A failing input is shrunk binder by binder toward zero,
  shorter strings, `false`, `null` and fewer array elements, as long as the
  property still fails.

The rung stops at 100 distinct inputs inside the claim, or after twenty
times as many draws, which is `UNKNOWN` (`gave_up`) if none satisfied
`when`. It calls the function outside the simulator, so it assumes the
function is pure.

### `PROVEN`: every input

With `--prover lean`, `--prover smt` or both, an engine proves the
property for every input, or refutes it. See [Provers](/guide/provers).

## `eutaxy report`: every spec at once

To check every spec file in a project without a scenario:

```sh
npx eutaxy report ./src --prover smt
```

```txt
./domain.ts
  PROVEN   decideRefund withinCaptured: by smt 5.3.2; also held on 100 generated input(s)
           number is modelled as the IEEE double (the floating-point theory): NaN, the infinities and -0 are in every binder's domain, and === is fp.eq
           string is modelled as a sequence of 16-bit code units, as JavaScript holds it
           …

1 property in 1 module: 1 PROVEN
```

`report` finds every `*.props.ts` under the directory, imports each module
and its spec file in a Node process of its own, runs `TESTED` and, with
`--prover`, `PROVEN`. No scenario runs, so nothing is `CHECKED`. A module
that does not load in Node, that ends its process, or whose properties do
not finish within 60 seconds, stays `UNKNOWN`. It exits 1 for a `REFUTED` or `CONFLICT` spec and
0 otherwise.
