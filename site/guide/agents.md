---
description: Running Eutaxy from a coding agent through the Model Context Protocol - eutaxy mcp, its tools (check, draft, report, goals, prove, prover_status), the proof loop with goal files, and what the agent cannot do.
---

# For coding agents

Eutaxy's verdicts depend only on files in the repository, and every
counterexample comes back as a regression test, so the loop "check, read
the report, fix or prove, check again" needs no human in the middle. For
a coding agent, `eutaxy mcp` serves that loop over the
[Model Context Protocol](https://modelcontextprotocol.io): one stdio
server, six tools, each returning the same JSON report the command line
prints with `--json`. Nothing in Eutaxy calls a model.

## Setup

Point the agent's MCP configuration at the command, run from the project's
directory. For Claude Code:

```sh
claude mcp add eutaxy -- npx eutaxy mcp
```

Any client works: the server speaks the stateless `2026-07-28` revision of
the protocol and the `initialize` handshake of `2025-11-25` and before.
Install a prover first if the agent is to prove anything
(`npx eutaxy prover install lean`), and tell the agent in its instructions
where the scenarios and spec files are.

## The tools

| Tool            | Does                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`         | Runs a scenario file and returns the report: the verdict, the shrunk trace on a violation, the spec verdicts, and `regressionTest`, the replay written beside it |
| `report`        | Runs every spec file under a directory through `TESTED` and, with `provers`, `PROVEN`                                                                            |
| `goals`         | Lists the properties the Lean engine could not prove, each with its statement, and writes them beside each spec file as `<spec>.goals.lean`                       |
| `prove`         | Runs the Lean engine on one spec file's module with the proofs supplied beside it, and returns its verdicts                                                       |
| `draft`         | Drafts a scenario from a wrangler config and the Worker module it names, with the invariants and events as holes to fill; returns the source and its notes        |
| `prover_status` | Says which engines are installed, and how to install one                                                                                                         |

A verdict is a result whatever it says: `VIOLATED` and `REFUTED` come back
as results with exit code 1 in the structured content, not as errors. A
tool error (`isError`) is a command that could not run, or an argument that
does not fit, with the text to act on.

## The proof loop

1. `goals` on the directory. Each module with open goals gets
   `domain.props.goals.lean` beside `domain.props.ts`: the goals described
   with the statements Eutaxy emits, then one open `-- proof:` part per
   goal, under two header lines naming the SHA-256 of the module and of the
   spec file.
2. Copy it to `domain.props.lean`, keep the header, put lemmas above the
   `-- proof:` parts and tactics under each.
3. `prove` on the spec file. Lean's kernel checks each proof against the
   statement Eutaxy emits, which the proof cannot change; a proof is
   accepted only when it rests on Lean's standard axioms, and a file using
   what could add an axiom, switch a check off or run code is refused
   whole. See [Provers](/guide/provers#supplying-proofs).
4. When the module or the spec changes, a proof file carrying the header
   is stale: nothing in it is `PROVEN`, and the verdicts say which file
   moved. Run `goals` again and bring the proofs over.

The agent cannot shorten this: there is no way to mark a property proven,
the statement is never the agent's, and a `sorry` refuses the file.
