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
| `--wrangler <path>`  | The wrangler config (default: the one the scenario names, else `wrangler.jsonc`, `.json` or `.toml` beside it) |
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
   `main` decides the classes there.) Every service binding in your config
   is replaced in the isolate by a function that is never called, since
   the scenario answers it (`service()`) or runs its Worker (`callee()`),
   so a binding may name a Worker that is not there. For a scenario with `callee()` steps it also reads
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

## `eutaxy draft`

```sh
eutaxy draft [wrangler config] [--worker <module>] [--out <file>] [--json]
```

Writes a scenario skeleton from a wrangler config (JSON or JSONC; default
`wrangler.jsonc` or `wrangler.json` in the current directory) and the
Worker module it names (`--worker` for another). It prints the scenario,
or writes it to `--out`, never over an existing file; paths in it are
relative to where it is written.

- **Setup**: each D1 binding with its schema file, each Durable Object, R2
  bucket and Workflow the Worker owns; a service binding becomes
  `callee()` when a wrangler config of that Worker's name is found under
  the directory, and a scripted `service()` otherwise.
- **Drive**: a queue consumer, else a Cron Trigger, else an Agent's
  WebSocket route, else `fetch()`; its events are a hole to fill.
- **Externals**: the hosts the code fetches by a literal URL.
- **Invariants**: a hole, with examples for the bindings found as
  comments. The scenario does not check until it has one.
- **Notes**: bindings the simulation does not model, other drives the
  Worker has, and anything guessed, written into the file as comments.

Nothing is imported or run. `--json` prints the draft as data with the
source and its notes.

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
a flag only `check` takes. For `check` it includes a run Vitest failed,
and the command says why: the check's test file could not run (the Worker
threw as it loaded, say) or failed outside its test (in a hook or the
pool's teardown), its test failed or left no verdict, or there were errors
nothing handled, each told once with how often it came. Vitest fails a run on an
error nothing handled even when the check's test passed.
