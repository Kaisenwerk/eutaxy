# Systems of Workers

End-to-end tests of `eutaxy check` on systems only the command can build:
a scenario whose Worker calls another by its real name, which the command
builds into one isolate from both wrangler configs (`callee()`). Each
directory holds the Workers, their wrangler configs, the scenarios, a
README saying what the system exercises, and `scenario.test.ts`, which
runs the command's bin (`packages/eutaxy/bin/eutaxy.mjs`) from Node and
asserts the verdicts.

The directory is a private workspace package so that the scenarios resolve
`eutaxy/cloudflare` as an adopter's do; nothing here is published.
