# secret-of-a-callee

A front Worker calling a notes Worker that needs a secret
(`envVar()` and `secret()`, `site/guide/scenarios.md`).
- **The callee's secret**: the notes Worker signs each note with a key it
  reads from `env.API_KEY` and refuses to work without one. A secret is set
  with `wrangler secret put`, so no wrangler config holds it: the scenario
  gives it, under the callee's qualified name, `secret("notes/API_KEY", …)`.
- **Vars the configs give**: the front Worker's config gives `REGION` a
  value and the callee's gives `TIER` one; the scenario's `envVar("REGION",
  "eu")` and `envVar("notes/TIER", "gold")` replace them for the check.
- **A Worker on its own** (`solo/`): no callee and no service binding, and
  a Durable Object that reads the secret off the env the runtime
  constructs it with.
- **The command**: `eutaxy check` puts the values in the isolate's env.

`given.sim.ts` gives them and the note is signed; `missing.sim.ts` gives
none, and the callee refuses; `solo.sim.ts` is the Worker on its own. The
test reads what each Worker read from `--console`, where a key's length is
printed, never the key.
