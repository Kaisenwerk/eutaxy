# Example: two Workers over a service binding

A checkout Worker charges orders through a payments Worker, reached over a
service binding by RPC (its `Payments` entrypoint). The payments Worker
keeps its promise: a charge is idempotent per key, and a second call with
the same key gets the first charge back. The checkout draws a fresh key
for each charge. Clients resend a payment request that got no answer.

## Run the check

From `examples/service-binding` in the repository:

```sh
pnpm install
pnpm check
```

The scenario in `checkout.sim.ts` names the payments Worker with
`callee()`, so both Workers' real code runs in one simulation, as
Cloudflare runs them on one thread: the RPC call is one effect that hosts
the payments Worker's invocation, and the payments database is
`payments/DB`. The check reports:

```
VIOLATED  checkout  (seed checkout)

Invariant one-charge-per-order is violated: 2 rows of charges in D1:payments/DB share order_id = "o-2"

Schedule (run seed ...), events kept: req-2
  crash_after at req-2#1 effect #0 (Service:PAYMENTS charge)
```

The payments Worker charged the order, and the checkout invocation died
before it answered. The client resent the request, the checkout drew a
new key, and the payments Worker, idempotent per key as it promises,
charged the order again. Each Worker is right by its own contract; the
two together are not, which only a run of both Workers' code shows.

## The fix

`worker.fixed.ts` derives the key from the order (`order:<id>`), so a
resend carries the key of the first attempt and gets its charge back.
`pnpm check:fixed` reports `BOUNDED`.

## Using it in your own project

`callee(binding, { entry, config })` runs the Worker behind a service
binding for real; `eutaxy check` reads its wrangler config and adds its
bindings under its name (`payments/DB`), and the entrypoint and props the
caller's binding names reach it. To check a caller against a Worker you
do not want to run, `service(binding, …)` scripts its answers instead.
