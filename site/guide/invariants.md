---
description: Invariants in Eutaxy - effect selectors and keys, delivery invariants such as at most once per key, state invariants over end-of-run snapshots of D1, Durable Objects, R2 and Workflows, and refines.
---

# Invariants

Invariants say what must hold in every run. They are plain data, checked by
pure functions over the run's effect log: every binding call, response,
acknowledgement and outbound request the Worker made, in order, plus a
snapshot of each binding's state after the last event.

## Effects, selectors and keys

Each effect in the log has a target (`D1:DB`, `Queue:payments`,
`Fetch:payments-api`, `Http:/refunds`), an op (`run`, `ack`, `POST`,
`response`), a kind (`call`, `result`, `fault`, `snapshot`) and a JSON
payload. The [effect conventions](/platforms/cloudflare#effect-conventions)
list what each binding records.

An **effect selector** picks records out of the log. The helpers build the
common ones:

| Selector                       | Selects                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `d1Write(binding, op?)`        | D1 `run` (or `batch`) results that changed at least one row                        |
| `d1Read(binding, op?)`         | D1 `first` (or `all`, `raw`) results                                               |
| `queueAck(queue)`              | The acknowledgement that took effect for each message                              |
| `fetchCall(external, method?)` | Requests to a declared external that took effect (not replayed under a dedupe key) |
| `httpResponse(path, { ok })`   | Responses the Worker returned for a path; `ok` narrows to 2xx or the rest          |
| `r2Op(binding, op?)`           | R2 operations that completed; a `put` only when it stored an object                |
| `workflowStep(binding, step?)` | A Workflow's step attempts                                                         |

A selector is plain data, so you can also write one by hand:
`{ target: "D1:DB", op: "run", kind: "result", where: { "args.params.0": "o-1" } }`.

A **key** is a dot path into an effect's payload, such as
`d1Param(0)` (which is `"args.params.0"`, the first bound parameter of a
D1 statement). Keys compare as canonical JSON.

## Delivery invariants

### `atMostOncePerKey(name, selector, key)`

No two selected effects share a key. The invariant that catches duplicate
side effects under retries:

```ts
atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0));
```

### `atLeastOncePerMessage(name, drive, selector, key, bodyKey)`

Every message (or request) of the drive has a selected effect whose key
equals the value at `bodyKey` in its body. Nothing delivered may be lost:

```ts
atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId");
```

When the shrinker removes events, the expected keys are derived again from
the events that remain, so a shrunk scenario never "violates" because its
expectations went stale.

### `atLeastOnce(name, selector, key, expected)`

Every value in `expected` appears as the key of a selected effect.

## State invariants

State invariants read the snapshot each setup step takes after the last
event. A missing snapshot is a violation, never a silent pass.

A **state query** names a table in a snapshot, optionally filtered by row
conditions (`{ column, op, value }` with `op` one of `eq`, `neq`, `gt`,
`gte`, `lt`, `lte`, `in`, or `notNull` without a value):

| Query                                        | Rows                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `d1Rows(binding, table, where?)`             | A D1 table                                                                       |
| `durableObjectRows(binding, object, where?)` | One object's storage as `{ key, value }`                                         |
| `r2Rows(binding, where?)`                    | A bucket's objects as `{ key, size, etag, customMetadata, httpMetadata, text? }` |
| `workflowRows(binding, where?)`              | A Workflow's instances as `{ id, status, params, output?, error? }`              |

The invariants over them:

```ts
// Every row the query selects satisfies the conditions.
everyRow("no-negative-balance", d1Rows("DB", "accounts"), [
  { column: "balance_cents", op: "gte", value: 0 },
]);

// No two selected rows share a value.
unique("one-row-per-order", d1Rows("DB", "payments"), "order_id");

// Every selected effect has a row whose column equals the effect's key.
implies(
  "acked-means-recorded",
  queueAck("payments"),
  "args.body.orderId",
  d1Rows("DB", "payments"),
  "order_id",
);

// Every selected row is named by a row of another query, as a foreign key is:
// no R2 object without the D1 row that points at it.
references("no-orphan-uploads", r2Rows("UPLOADS"), "key", d1Rows("DB", "files"), "object_key");
```

## `refines`

System invariants say what the system must do. `refines` says the Worker
does what its pure core decided. When a scenario lists the core's modules
in `specs`, every call into their functions is recorded as a decision
(`Core:<function>`, payload `{ args, result }`) of the invocation that made
it.

```ts
refines(name, decision, effectSelector, { follows, state });
```

checks that every selected effect:
1. carries out the **latest decision** of its invocation (an effect with
   none is a violation, so forgetting to list the module never passes
   quietly);
2. agrees with that decision on each `follows` pair, a path into the
   effect's payload and a path into the decision's;
3. with `state`, rests on a **read** its invocation made before the
   decision that no other invocation's **write** to the same key made stale
   before the effect committed.

The third check catches the lost update, where every decision is right for
the state it saw. Two partial refunds of one order arrive at once; each
reads the refunded total, decides, and writes:

```ts
export default defineScenario({
  name: "refund-lost-update",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: http(
    [
      { path: "/refunds", body: { orderId: "o-1", amountCents: 600 } },
      { path: "/refunds", body: { orderId: "o-1", amountCents: 400 } },
    ],
    { retries: 0 },
  ),
  specs: ["./domain.ts"],
  invariants: [
    refines("refund-follows-decision", "decideRefund", d1Write("DB"), {
      follows: [{ effect: d1Param(1), decision: "result.refunded" }],
      state: { read: d1Read("DB"), write: d1Write("DB"), key: d1Param(0) },
    }),
  ],
  // No faults: the interleaving alone loses the update.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2 },
});
```

The violation names the stale read: the second write carries out a decision
that rested on a read of `o-1`, and the first request changed `o-1` before
that write committed.

`refines` does not replace system invariants: a Worker can follow its core
faithfully and still break a system property, so check both.
