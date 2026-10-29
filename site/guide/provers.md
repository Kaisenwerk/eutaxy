---
description: Eutaxy's two first-party proof engines - TypeScript to Lean 4, checked by the Lean kernel, and TypeScript to SMT-LIB over Z3 with IEEE doubles. Installing them, the supported TypeScript subset, supplied proofs, and CONFLICT verdicts.
---

# Provers

Proving is optional. `CHECKED` and `TESTED` need no engine, and an engine
that is not installed only leaves a verdict where the lower rungs put it,
with the reason and the command that installs it. When an engine is
named, it proves each property for every input or refutes it, and every
`PROVEN` names the engine, its version, and the model of the language it
assumed.

Eutaxy ships two engines of its own, so the strongest verdict never depends
on another project's roadmap. They read the same TypeScript subset and
divide the work by what each decides well.

| Engine | Proves with                      | Models `number` as              | Best for                                                               |
| ------ | -------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `lean` | Lean 4; the kernel checks proofs | The unbounded integers          | Recursion and induction over lists; termination (`total`)              |
| `smt`  | Z3 over SMT-LIB 2                | The IEEE double, `NaN` included | Doubles, strings as code units, records, nullable types, tagged unions |

Name one or both:

```sh
npx eutaxy check ./payments.sim.ts --prover lean,smt
npx eutaxy report ./src --prover smt
```

## Installing the toolchains

Each engine is pinned to one release, and nothing is downloaded during a
check.
- **Lean**: install [elan](https://elan.lean-lang.org), Lean's toolchain
  manager, then the pinned release:

  ```sh
  elan toolchain install leanprover/lean4:v4.35.0
  ```

- **Z3**: version 5.3.2 on the `PATH`, from the
  [Z3 releases](https://github.com/Z3Prover/z3/releases/tag/z3-5.3.2) or
  `brew install z3`.

## The Lean engine

Translates the module to Lean 4, states each property as a theorem with
`when` as hypotheses, and discharges it with one tactic script: booleans to
propositions, the module's definitions unfolded, each conditional split,
then `omega`. Lean's kernel, not Eutaxy, checks the proof. A proof that
does not close is `gave_up`, since Lean does not say whether the claim is
false or the script too weak; the `TESTED` rung is what refutes. `total` is
`PROVEN` when Lean accepts the definition, which it does only for functions
that terminate.

Its model is an assumption every verdict states: `number` is the unbounded
integers (no overflow, no fractions, no `NaN`), and `string` is Lean's
`String`, a sequence of Unicode characters.

### Supplied proofs

Where the tactic script cannot close a goal (induction, most often), a proof
can be supplied beside the spec file: `domain.props.lean` beside
`domain.props.ts`, lemmas first, then a `-- proof: <property>` section of
tactics per property. The statement stays Eutaxy's: each property's
statement is emitted before any supplied text, Lean's kernel must accept
the proof, and the proof may rest on no axiom beyond Lean's standard ones,
read from Lean's `#print axioms` (`sorry` is an axiom there). The verdict
says the proof was supplied. That is what keeps a coding agent from taking
the short way to `PROVEN`.

A supplied proof is code in your repository, trusted as the spec file
beside it is. Text that could change how Lean checks the file (`#`
commands, attributes, macros, `axiom`, `sorry`, `set_option`, `import` and
their kin) refuses the whole file wherever it appears.

## The SMT engine

Emits the same subset as SMT-LIB 2 and decides it with Z3. It models what
the Lean engine assumes away: `number` is the IEEE double (`NaN`, the
infinities, `-0` and integers past 2^53 are in every binder's domain),
`string` is a sequence of 16-bit code units as JavaScript holds it, and
records, tagged unions and nullable types are algebraic datatypes.

Budgets are the solver's resource limit, never wall-clock time, so the same
input gives the same outcome on every machine. `unsat` is `PROVEN`. A
`sat` model is only a candidate counterexample: Eutaxy runs your TypeScript
function on it first, and only a claim that fails on the real function is
`REFUTED`. A model the function does not confirm is a modelling gap,
reported as `UNKNOWN` with the input.

## When engines disagree

Take the spec from [Specs](/guide/specs) without its integer guard:

```ts
export const unguarded = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
```

Over the integers it holds, and Lean proves it. Over doubles it does not:
`amount = NaN` gets past both checks and makes the total `NaN`. Run both
engines and Eutaxy reports the disagreement instead of picking a side:

```txt
  CONFLICT decideRefund unguarded: lean 4.35.0 proves it, simulator TESTED refutes it; not resolved automatically
           captured = 0, refunded = 0, amount = NaN
```

`CONFLICT` fails the check like a refutation and is never resolved
automatically. The fix is to state the claim you mean: add
`Number.isInteger(amount)` to `when`, and both engines prove it.

## The TypeScript subset

The engines read a defined pure subset of TypeScript, widened one class at
a time and specified by a contract corpus of functions with known outcomes.
Today it covers:
- **Functions**: exported functions (declarations and `const` arrows) over
  `number`, `boolean`, `string`, records, nullable types, tagged unions and
  lists, returning any of those.
- **Bodies**: `const` bindings, `if` with early returns, `return`.
- **Expressions**: `+ - *` on numbers, `+` on strings, comparisons,
  `===`/`!==` on primitives and against `null`, `&& || !`, the conditional
  operator, string and record literals, field reads, `Number.isInteger`,
  and calls to the module's own functions.
- **Narrowing**: a null check narrows a nullable in the branch it guards; a
  test of a union's tag narrows the union, in functions and in claims.
- **Lists** (Lean): array literals with a trailing spread, `length`,
  `xs[0] ?? fallback`, `slice(1)`, `map`, `flatMap`, `every`, `some`,
  `reduce`, and structural recursion on a list's `slice(1)`.

A function outside the subset, or one calling such a function, is
`UNKNOWN` (`unsupported`) with the construct and its line, and the rest of
the module still goes through. The [design document](/reference/design#provers)
has the exact boundary.
