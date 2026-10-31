# v0-10-workers-calling-each-other

The v0.10 gate (`docs/roadmap.md`, "Workers that call each other"): one
Worker of a system split by business context, checked on its own with the
Workers it calls scripted.
- **Driven over RPC**: the storefront calls `Orders.placeOrder` and
  `Orders.confirmShipment`, a named `WorkerEntrypoint`, resending a call
  that threw or got no answer.
- **Calls another Worker through a service binding**: the logistics partner's
  `quote` and `shipment` methods, scripted by the scenario.
- **Sends events to a Workflow that waits for them**: each order's
  `Fulfilment` instance waits for its `shipped` event, then marks the order
  shipped in D1.
- **Driven by cron**: the reconciliation tick asks the partner about orders
  still placed and delivers the shipments it knows of as events.

Both scenarios must be `BOUNDED`: every step is idempotent on the order id,
so a lost answer and the resend that follows change nothing. The third test
shows a fault-free run crossing all four boundaries.
