# console-output

A front Worker and the notes Worker it calls, both writing to the console
(`eutaxy check --console`, `site/reference/cli.md`).
- **The Workers**: the front Worker hands each note to the notes Worker over
  RPC; a note with no text is refused, and both say so on the console, the
  way a developer finds out why a call was refused.
- **The command**: by default a check shows none of it. With `--console`
  everything the Workers wrote, the callee's included, is printed on stderr
  as Vitest reported it, once per run of the scenario, and the verdict on
  stdout is as without the flag.

The scenario is `BOUNDED`; the test runs the command with and without the
flag and compares the two streams.
