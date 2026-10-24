# @eutaxy/spec

**Purpose.** `SpecIR`, the Lemma annotation parser and printer. Function
specs are Lemma (`@ensures{name} forall (x: int) { … }`, `@total`,
`@throws`) in JSDoc on exported functions; this package turns them into
plain data and back.

**Public surface.** The IR types (`Property`, `Binder`, `Guard`,
`Formula`, `FunctionSpec`, `ModuleSpecs`); `parseProperty` (throws
`LemmaSyntaxError`, with the stage that rejected it); `printProperty` and
`printFormula` (canonical Lemma; parsing what they print gives the same
IR); `extractSpecs` (the annotations in a module's source, the names it
exports, and the annotations that did not parse, with lines);
`predicateSource` (a property as TypeScript source for a predicate over
its binders, for code generation: no `eval`).

The parser follows lemma-lang's `grammar.ebnf` and its side conditions on
atoms; the conformance fixtures and the tests that hold it to them live in
`corpus/lemma-conformance`. Leaves are TypeScript expressions kept
verbatim; whether their free identifiers are exports is checked where they
are evaluated.

**May import.** nothing outside this package. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5. See `docs/design.md` and `docs/roadmap.md`.
