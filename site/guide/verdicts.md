---
description: Every Eutaxy verdict - VIOLATED, BOUNDED and UNSUPPORTED for scenarios, CHECKED, TESTED, PROVEN, REFUTED, UNKNOWN and CONFLICT for specs - what each means, what it rests on, and the exit codes.
---

# Verdicts

Eutaxy keeps two kinds of verdict apart in every report: verdicts about a
**scenario** (does the Worker survive faults and concurrency?) and verdicts
about a **spec** (is a pure function right?). Nothing is ever reported as
verified when it was only explored or sampled.

## Scenario verdicts

| Verdict       | Means                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| `VIOLATED`    | A replayed, shrunk run breaks an invariant                              |
| `BOUNDED`     | No violation in any explored run within the stated bounds. Not a proof. |
| `UNSUPPORTED` | The run touched something Eutaxy cannot control, or did not replay      |

`UNSUPPORTED` names its cause: an unproxied binding, a request to an
undeclared host, an invocation waiting on something outside the
simulation, module-level state that leaked between runs, a run that did not
replay. It is never a quiet pass.

## Spec verdicts

| Verdict    | Means                                                                     |
| ---------- | ------------------------------------------------------------------------- |
| `CHECKED`  | Held on every input the simulator passed to the function                  |
| `TESTED`   | Held on those and on inputs generated from the parameter types            |
| `PROVEN`   | Proved for every input by a named engine                                  |
| `REFUTED`  | A counterexample was found at some rung; it comes with the input, shrunk  |
| `UNKNOWN`  | No rung could decide: `gave_up`, `unsupported` or `unavailable`, with why |
| `CONFLICT` | Two engines disagree, or an engine proves what a lower rung refuted       |

A counterexample at any rung is always an error. A weak, missing or
inapplicable prover only lowers a verdict. `CONFLICT` is never resolved
automatically.

## What every verdict carries

Every verdict carries what it rests on:
- **Simulation**: the seed, the bounds actually reached, the number of runs,
  effect points and faults, and, for `--exhaustive`, whether the
  enumeration completed and whether partial-order reduction stayed on.
- **Specs**: how many inputs a property held on, the seed they were drawn
  with, the engine's name and version for `PROVEN`, and whether a proof was
  supplied.
- **Assumptions**: the fault model, the platform model with the Cloudflare
  documentation it follows, the declared externals, and each engine's model
  of the language (`number` as integers or as doubles).

## Exit codes

| Command         | 0         | 1                                             | 2             | 3     |
| --------------- | --------- | --------------------------------------------- | ------------- | ----- |
| `eutaxy check`  | `BOUNDED` | `VIOLATED`, or a `REFUTED` or `CONFLICT` spec | `UNSUPPORTED` | error |
| `eutaxy report` | otherwise | a `REFUTED` or `CONFLICT` spec                |               | error |

## JSON report

Every command takes `--json` and prints one object in a versioned schema
(`schemaVersion` 1, canonical JSON) for CI and coding agents. Within a
version, new verdict kinds and optional fields may appear, so a consumer
switches on `kind` with a default branch; a removed or re-typed field bumps
the version.
