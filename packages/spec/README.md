# @eutaxy/spec

**Purpose.** `SpecIR`, and the two combinators a spec file writes. Function
specs are TypeScript, in a spec file beside the module (`domain.ts` has
`domain.props.ts`): `forall(f, { when, ensures })` quantifies over `f`'s
parameter types, `total(f)` claims termination. Both return plain data
holding the function, so the user's compiler types the arrows' parameters
as `f`'s. This package is what `eutaxy/spec` exports; it runs wherever the
module under spec runs, workerd included.

**Public surface.** `forall`, `total`, `isSpec` and their types (`Forall`,
`Total`, `Spec`, `Fn`); the IR types (`ModuleSpecs`, `FunctionSpec`,
`Property`, `Binder`, `Param`, `SpecType`, `Hint`, `Arrow`, `SpecError`)
and `describeType`. The reader that turns a module and its spec file into
the IR lives in `@eutaxy/prover/reader`; this package holds no parser.

**May import.** nothing outside this package. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5 (Lemma annotations), v0.7 (TypeScript specs). See `docs/design.md` and `docs/roadmap.md`.
