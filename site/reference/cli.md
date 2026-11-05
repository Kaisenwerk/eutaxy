---
description: The eutaxy command line - eutaxy check runs a scenario inside workerd, eutaxy report runs every spec in a directory, eutaxy prover install puts a proof engine on the machine, and eutaxy mcp serves a coding agent; every flag, the generated files, and the exit codes.
---

# CLI

```sh
eutaxy check <scenario.sim.ts> [options]
eutaxy report [dir] [--prover <names>] [--seed <seed>] [--goals] [--json]
eutaxy prover install <lean|smt> [--from <url or directory>] [--json]
eutaxy mcp
```

## `eutaxy check`

Runs one scenario inside workerd through your Vitest and the Cloudflare
Vitest plugin, prints the verdict with its trace and assumptions, checks
the specs of the modules the scenario lists, and writes a regression test
on a violation.

| Option               | Does                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `--wrangler <path>`  | The wrangler config (default: `wrangler.jsonc`, `.json` or `.toml` beside the scenario) |
| `--seed <seed>`      | The exploration seed (default: the scenario's file name)                                |
| `--max-runs <n>`     | Cap the exploration runs, in addition to the time budget                                |
| `--budget-ms <n>`    | Replace the scenario's time budget; with `--max-runs`, the run cap decides              |
| `--exhaustive`       | Run every schedule within the bounds once, with partial-order reduction                 |
| `--prover <names>`   | Also run the `PROVEN` rung on the scenario's specs: `lean`, `smt`, or `lean,smt`        |
| `--json`             | Print the versioned JSON report instead of text                                         |
| `--out <path>`       | Where to write the regression test on a violation                                       |
| `--no-regression`    | Do not write a regression test                                                          |
| `--expect-violation` | Write a regression test that asserts the violation is still there                       |
| `--keep`             | Keep the generated `.eutaxy/` directory                                                 |

What it does:
1. Reads the spec files of the modules the scenario's `specs` names, on the
   Node side, through your TypeScript compiler.
2. Writes `.eutaxy/` beside the scenario: a test that performs the check
   inside workerd and a Vitest config with the Cloudflare plugin pointed at
   the wrangler config, its main module the scenario's `worker.entry` (the
   scenario is imported in Node for it), so the Durable Object and Workflow
   classes that run are the ones that module exports, even when it is not
   the config's `main`, as a fixed variant of a Worker usually is. (The
   regression test it writes runs under your own Vitest config, whose
   `main` decides the classes there.) For a scenario with `callee()` steps it also reads
   each callee's wrangler config (JSON or JSONC), writes a main module that
   re-exports your Worker's exports and the callees' Durable Object and
   Workflow classes under qualified aliases, and adds the callees'
   resources to the isolate under `<name>/<binding>` through the plugin's
   miniflare options; the test imports the callees' modules.
3. Runs your Vitest there and reads the verdict back through Vitest's JSON
   reporter; nothing depends on console output.
4. With `--prover`, runs the named engines on the observed modules and
   folds their results into the spec verdicts.
5. Prints the report, writes `<name>.regression.test.ts` on a violation,
   and removes `.eutaxy/` unless `--keep` is given.

For CI, or any test that asserts a verdict, give a generous `--budget-ms`
and a `--max-runs` cap, so the number of runs does not depend on the
machine.

## `eutaxy report`

Runs every spec file (`*.props.ts`) under a directory, default the current
one, with no scenario.

| Option             | Does                                                     |
| ------------------ | -------------------------------------------------------- |
| `--prover <names>` | Also run the `PROVEN` rung: `lean`, `smt`, or `lean,smt` |
| `--seed <seed>`    | The seed for generated inputs (default: `report`)        |
| `--goals`          | Write each module's open Lean goals beside its spec file as `<spec>.goals.lean` and list them (needs `--prover lean`) |
| `--json`           | Print the versioned JSON report instead of text          |

Each module and its spec file are imported in a Node process of their
own, where a relative import from a `.ts` file resolves as TypeScript
resolves it. Properties start at `TESTED`, since no scenario ran. A module
that does not load in Node, that ends its process, or whose properties do
not finish within 60 seconds, leaves its properties `UNKNOWN`.

A goal file is a proof file with every proof open: the properties the
Lean engine could not prove, each with the statement it tried, and two
header lines naming the SHA-256 of the module and of the spec file.
Copy it to `<spec>.lean`, add lemmas and tactics, and run the report
again; see [Provers](/guide/provers#supplying-proofs). A proof file whose
module or spec changed since is stale, and nothing in it is `PROVEN`.

## `eutaxy prover install`

Puts the pinned Lean or Z3 release for this platform in Eutaxy's cache,
checksum-verified, where `--prover` finds it first. See
[Provers](/guide/provers#installing-the-toolchains).

| Option                      | Does                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `--from <url or directory>` | A mirror or an offline directory holding the release file under its name |
| `--json`                    | Print what was installed, from where, and the checksum                    |

## `eutaxy mcp`

Serves the [Model Context Protocol](https://modelcontextprotocol.io) over
stdio, so a coding agent runs Eutaxy through one tool: see
[For coding agents](/guide/agents). It takes no arguments; the agent's MCP
configuration names the command.

## Exit codes

| Code | `check`                                       | `report`                       |
| ---- | --------------------------------------------- | ------------------------------ |
| 0    | `BOUNDED`                                     | no spec refuted or in conflict |
| 1    | `VIOLATED`, or a `REFUTED` or `CONFLICT` spec | a `REFUTED` or `CONFLICT` spec |
| 2    | `UNSUPPORTED`                                 |                                |
| 3    | an error                                      | an error                       |

`prover install` exits 0, or 3 on an error; `mcp` exits 0 when its input
closes.

An error includes an unknown engine name, a spec file that does not read,
a listed module that is missing, and, for `report`, no spec files found or
a flag only `check` takes.
