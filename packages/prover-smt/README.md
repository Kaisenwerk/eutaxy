# @eutaxy/prover-smt

**Purpose.** Eutaxy's second first-party engine: the pure TypeScript subset
to SMT-LIB 2, decided by Z3, one script per property, every model replayed
through the spec file before it is called a counterexample. It models what
the Lean engine assumes away: `number` is the IEEE double (NaN, the
infinities and `-0` are in every binder's domain, `===` is `fp.eq`),
`string` a sequence of 16-bit code units, a record a datatype, a tagged
union a datatype with a constructor per member holding that member's
record (wrapped where the union is expected, unwrapped where a tag test
narrows to it, so a record can be a member of several unions), a nullable type an option
datatype (`none` for `null`), a name narrowed by a null check bound to the
option's value in the branch the check guards. Lists (arrays) and the
operations on them are not taken here: a function or property using one is
`unsupported`, and the Lean engine takes them. Runs on the
Node side, over a process boundary: nothing here is loaded into workerd.

**Public surface.** `smtProver` (the engine as a `Prover`: `available`
when the pinned Z3 is installed, `prove` is `proveModule`); `proveModule`
(a module's properties, read with its spec file, through the subset reader,
the emitter and Z3: `unsat` is `PROVEN` with engine name, version and
assumptions; a model is decoded, the spec file's own `when` and `ensures`
are run on it, and only a claim that fails is `REFUTED`, shrunk as the
TESTED rung shrinks, while a model the function does not confirm is
`UNKNOWN` (`unsupported`) with the input; the resource limit reached is
`gave_up`; a function or property outside the subset `unsupported`; no
pinned solver `unavailable`; `total` is left to Lean); `prepare` (read and
emit without running Z3); `prelude`, `propertyScript`, `term`, `value`,
`equal` and `ident` (the SMT-LIB text: `f_` functions, `R_` datatypes,
`mk_` constructors, `fld_` selectors, `v_` variables); `parseSExprs`,
`readAnswer`, `decode` (Z3's answers and model values back to JavaScript
values); `findZ3`, `solve`, `z3Version`, `defaultResourceLimit`,
`installHint`.

**Solver.** Pinned to `z3Version` in `src/z3.ts`, found on the PATH (or
`EUTAXY_Z3`, or the usual install prefixes) and required to report that
version; nothing is downloaded during a check. Every run carries Z3's
resource limit (`rlimit`), a machine-independent budget, so the same script
gives the same outcome everywhere; the wall-clock timeout is only a safety
net. The contract corpus in `corpus/prover-contracts` names what this
engine must prove, refute and give up on; CI installs the pinned Z3 and
runs it with `EUTAXY_REQUIRE_Z3=1`.

**May import.** `@eutaxy/prover`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.7. See `docs/design.md` and `docs/roadmap.md`.
