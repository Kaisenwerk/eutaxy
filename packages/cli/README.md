# @eutaxy/cli

**Purpose.** The `eutaxy` command: `check`, `prove`, `report`, `prover install`, config loading, engine discovery.

**Public surface.** `main` (the command), `runCheck`, `cloudflareRegressionTest`, the generators for the check test and Vitest config, and `checkInWorkerd` with its `CheckTransport` (the half of the check that runs inside workerd: the generated test holds only its module globs and one call to it; `workerd.ts` and `keys.ts` import nothing that needs Node). `eutaxy check <scenario.sim.ts>` writes `<dir>/.eutaxy/`, runs the user's Vitest with the Cloudflare plugin there, reads the verdict back from the test's task meta through Vitest's JSON reporter, prints text or `--json` (`--exhaustive` runs every schedule within the bounds), writes `<name>.regression.test.ts` on a violation, and exits 0/1/2 for BOUNDED/VIOLATED/UNSUPPORTED (1 also when a spec is REFUTED). For a scenario's `specs`, it extracts the Lemma annotations of every module next to the scenario, compiles their predicates into `.eutaxy/specs/`, one file per module loaded only when named, importing nothing (the atom checks come in as parameters) (`findSpecModules`, `specFiles`), and the generated test observes the listed modules while the scenario runs and reports their spec verdicts; a listed module that is missing or has annotations that do not parse exits 3. `--prover <name>` (`lean`) runs the `PROVEN` rung on the Node side after the check: each named engine on each observed module's source (`proveSpecs`, the engines in `provers`), folded into the spec verdicts by `aggregate`; a `CONFLICT` exits 1 like a refutation, an unknown engine name 3.

**May import.** `@eutaxy/spec`, `@eutaxy/core`, `@eutaxy/engine`, `@eutaxy/cloudflare`, `@eutaxy/prover`, `@eutaxy/prover-lean`, `@eutaxy/prover-thales`, `@eutaxy/prover-lemmascript`, `@eutaxy/report`, `@eutaxy/aws`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4 onward. See `docs/design.md` and `docs/roadmap.md`.
