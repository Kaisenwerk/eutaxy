# Eutaxy — development rules

Eutaxy is an open-source tool for **formal proof and deterministic simulation**
of TypeScript programs and cloud-provider primitives, Cloudflare first
(Workers, Durable Objects, KV, Queues, D1, R2, Workflows). The design is in
`docs/design.md`, the phase plan in `docs/roadmap.md`. These rules apply to
every contribution.

## 1. Working conventions

1. **Keep the design current, not its history.** `docs/design.md` and
   `docs/roadmap.md` are the record of what is decided. Change them in place
   when a decision changes, with the rationale next to the choice; do not
   annotate them with what they used to say. A decision that is not obvious
   from the code and the design gets its reasons written down in the same
   pull request that implements it.
2. **Every task ends verified.** "Done" means the change is implemented, tests
   pass, docs are updated, and the result was checked by running it, not by
   reading it. Report failures and skipped steps plainly.
3. **Small, reviewable steps.** Each pull request should be small enough to
   review in minutes and describe in one paragraph.
4. **Contribution flow.** Every change, the maintainers' included, reaches
   `main` through a pull request. Before it is opened, `pnpm check` passes,
   the change was run, and it has been reviewed, with what the review finds
   settled in the change itself. The pull request's title is a Conventional
   Commit of at most 64 characters. Its body says what changes, why this
   way, and how it was checked, and names any deliberate change in behavior.
   The repository's owner merges every pull request. Bug reports and feature
   requests go in GitHub Issues; planning lives in `docs/roadmap.md`. Work
   outside the current phase of the roadmap needs its reason written into
   the roadmap.

## 2. Engineering standards

5. **TypeScript strict, ESM only.** `strict: true`, no `any` without a comment
   saying why, no `@ts-ignore` (use `@ts-expect-error` with a reason).
6. **Toolchain:** Node LTS, `pnpm` workspaces, `vitest` for tests, `biome` for
   lint and format, `tsc -b` over TypeScript project references for type
   checks. One `pnpm check` script runs all of them; it must
   pass before any commit.
7. **Determinism is the product.** `spec` and `core` contain no `Date.now`,
   `Math.random`, timers, real I/O, or environment reads. All effects go
   through injected interfaces with seeded or scripted implementations; only
   `engine` patches globals. A simulation run with the same seed and inputs
   must produce byte-identical traces. A test enforces this.
8. **Claims are executable.** Any proof rule, simulator feature, or provider
   model ships with at least one runnable example and one test that would
   fail if the claim were false. Provider models (e.g. Durable Object
   semantics) cite the Cloudflare documentation they are based on.
9. **Tests accompany behavior.** No behavior change without a test. Bug fixes
   start with a failing test.
10. **Zero runtime dependencies.** `spec` and `core` import nothing outside
    the repo. The published package has no runtime dependencies; Vitest and
    the Cloudflare Vitest plugin are peer dependencies. Dev dependencies are
    deliberate: prefer the standard library, and say why in the commit that
    adds one.
11. **Public API is versioned.** Exported API follows semver. Breaking changes
    get a changelog entry and a migration note.
12. **Commits.** Commit messages and pull request titles are Conventional
    Commits; the Pull request workflow checks every pull request's title. A
    `BREAKING CHANGE:` or `Release-As:` footer goes on its own line in the
    pull request body. A commit by a co-author ends with a `Co-Authored-By:`
    trailer. `main` is always green.

## 3. Scope discipline

13. **Dependencies point down.** Each package may import only what
    `docs/design.md` lists for it, declares exactly that in `package.json`,
    and mirrors it in its project references; pnpm links nothing else, and
    a test keeps the three in sync. Only `cloudflare` knows about Cloudflare;
    a future platform is a sibling package implementing `Platform`. `core`
    and `engine` never import provers. A second platform is added only
    once the first is useful end to end; AWS (Lambda, SQS, DynamoDB) came
    after the Cloudflare simulator gate passed.
14. **Small modules, small context.** Every package does one thing and has
    a `README.md` of under a page stating its purpose, its public surface
    and what it may import, so that a change to it can be made by reading
    that package alone. A change that needs to touch more than two packages
    is a sign the boundary is wrong; fix the boundary or record why not.
15. **Build for the current phase only.** No speculative abstractions;
    generality is earned by a second concrete use, not assumed.
    `docs/roadmap.md` names the current phase and its gate; a phase is done
    when its gate passes in CI.
16. **Open source hygiene.** Apache-2.0 license, `README`, `CONTRIBUTING`,
    `CHANGELOG`, and a code of conduct live at the repo root. Nothing private
    (keys, account ids, internal URLs, local notes) ever enters the repo.

## 4. Repository layout

```
CLAUDE.md                  these rules
README.md                  what Eutaxy is and how to use it
docs/design.md             the design: verdicts, layers, fault model, provers
docs/roadmap.md            phases and gates
packages/spec/             SpecIR and the spec combinators (imports nothing)
packages/core/             effect log, faults, schedulers, invariants, shrinker, verdicts
packages/engine/           run loop, virtual clock, globals patching, replay
packages/cloudflare/       binding proxies, platform model, Vitest integration
packages/aws/              AWS SDK proxy, SQS delivery model, DynamoDB reset and snapshots
packages/prover/           Prover interface, ladder, aggregation
packages/prover-lean/      first-party TypeScript-subset-to-Lean 4 engine
packages/prover-smt/       first-party TypeScript-subset-to-SMT-LIB engine (Z3)
packages/report/           text, JSON, Vitest regression emitter
packages/cli/              commands, config, engine selection
packages/eutaxy/           the published facade, eutaxy
corpus/                    planted bugs, differential scenarios, prover contracts (never published)
examples/                  runnable examples that double as acceptance tests
site/                      the documentation site, eutaxy.dev (VitePress; never published to npm)
scripts/                   release and docs helpers (the README on the npm page, the API reference pages)
```

## 5. Changing these rules

Rules change by editing this file, with the reason in the commit message.
