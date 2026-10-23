# Contributing

Eutaxy is pre-release. Issues and pull requests are welcome; the rules below
keep the project consistent.

## Rules

The development rules live in [CLAUDE.md](CLAUDE.md) and apply to every
contribution: strict TypeScript, determinism in the core, tests with every
behaviour change, zero runtime dependencies, one package per concern.

## Workflow

1. Fork and branch from `main`.
2. Run `pnpm install`, make the change, and keep `pnpm check` green.
3. Every behaviour change comes with a test. Bug fixes start with a failing
   test.
4. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
   and end with a `Co-Authored-By:` trailer for each co-author.
5. Open a pull request against `main`. Describe what changed and why in a
   paragraph; link the roadmap phase it belongs to.

Work outside the current roadmap phase is best raised as an issue first.

## Layout

Each package under `packages/` has a `README.md` stating its purpose, public
surface and allowed imports. A change should normally touch one package; if
it needs more than two, say so in the pull request.

## Releasing

Releases are driven by commit messages. On every push to `main`,
[release-please](https://github.com/googleapis/release-please) keeps a
release pull request open that bumps the version (the workspace root and
`packages/eutaxy/package.json` together) and adds the next `CHANGELOG.md` section from the Conventional Commits since
the last tag (`feat` is a minor bump before 1.0, `fix` a patch, `feat!` or a
`BREAKING CHANGE:` footer a major). Merging that pull request creates the
GitHub release and the `vx.y.z` tag, and the `publish` job of the same
workflow publishes `eutaxy` to npm through trusted publishing
with provenance. No npm token is stored anywhere, and nothing is published
by hand after the first version.

The publish job runs `pnpm check` before it builds and publishes.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
