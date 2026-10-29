---
description: Deterministic simulation of AWS Lambda functions consuming SQS with DynamoDB - the AWS SDK as the effect boundary, the SQS delivery model, batch item failures, and DynamoDB reset and snapshots.
---

# AWS Lambda

The same engine checks AWS Lambda functions consuming SQS with DynamoDB.
Everything above the platform is shared: faults, exploration, invariants,
shrinking, replay, the report. Import from `eutaxy/aws`.

## How it differs from Cloudflare

- **Runtime.** Lambda handlers run in plain Node, so no runtime emulator is
  needed: the engine, the handler and the local services share one process.
  The handler receives an SQS event with one record and a Lambda context
  whose request id and clock are virtual.
- **Effect boundary.** Every AWS SDK v3 client sends through one `send`
  method. For the duration of a run it is replaced: each call becomes an
  effect point, and the real work is sent to a local client you give the
  platform, matched by the calling client's class name
  (`DynamoDBClient`, `DynamoDBDocumentClient`). The handler's own clients,
  built at module scope as Lambda code does, never reach the network.
- **State.** DynamoDB semantics, conditional writes included, come from a
  local DynamoDB you run (DynamoDB Local, LocalStack or dynalite). Tables
  are reset before each run and snapshotted after it.

## Delivery model

As AWS documents for SQS event sources:
- A successful return deletes the message. The deletion is recorded as an
  implicit `delete` effect, the point where a crash lands between "handled"
  and "deleted".
- A thrown error, or a reported batch item failure, leaves the message to
  be redelivered.
- After the queue's `maxReceiveCount` deliveries, it is dead-lettered.

## Scenario

```ts
import { defineAwsScenario, dynamoTable, dynamoWrite, sqs } from "eutaxy/aws";
```

`defineAwsScenario` takes the same shape as a Cloudflare scenario: `sqs`
builds the drive, `dynamoTable` the setup, `dynamoWrite(table, op)` selects
committed writes, `sqsDelete(queue)` the deletions, and `dynamoRows` queries the end-of-run snapshot for
state invariants. `createAwsPlatform` runs it, given the handler and the
local clients.

## Effect conventions

| Target             | Op                                                 | Payload                                                                                                                               |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DynamoDB:<table>` | the command name without `Command`, e.g. `PutItem` | `{ args: <command input> }`; writes' results have `written`, `GetItem` `found`, `Query` and `Scan` `count`; a failed call has `error` |
| `SQS:<queue>`      | `delete`                                           | `{ args: { messageId, implicit: true } }` after a successful return                                                                   |
| `SQS:<queue>`      | `dead_letter`                                      | `{ args: { messageId, attempts } }`                                                                                                   |
| `DynamoDB`         | `snapshot`                                         | `{ tables: { <table>: [items] } }`, items unmarshalled, after the last event                                                          |

DocumentClient commands are recorded under the low-level name (`PutCommand`
as `PutItem`). A batch or transaction names every table it touches, sorted
and joined with `+` (`DynamoDB:audit+payments`).

## Limits

- Only the promise form of `send` is modelled; the callback form makes the
  run `UNSUPPORTED`.
- A client class without a local counterpart makes the run `UNSUPPORTED`.
- Concurrent invocations are not supported on this platform yet.
- While an effect performs its real I/O, timers the SDK schedules inside it
  are real (SDKs back off and time out with them), while timers the handler
  schedules stay virtual; the clock, `Date` and randomness stay virtual
  throughout.
