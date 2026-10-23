# @eutaxy/aws

**Purpose.** Everything that knows about AWS: the SDK `send` proxy that
turns every client call into an effect point, the SQS-to-Lambda delivery
model, DynamoDB table reset and end-of-run snapshots, and the differential
runner. Lambda handlers run in plain Node; no emulator of the runtime is
needed. DynamoDB calls execute against a local DynamoDB the user runs
(DynamoDB Local, LocalStack, or dynalite in this repository's tests).

**Public surface.** `createAwsPlatform` (SDK proxy, SQS delivery with
at-least-once semantics and batch item failures, table reset, snapshots),
`defineAwsScenario`, `sqs`, `dynamoTable`, `dynamoWrite`, `dynamoRows`,
`sqsDelete`, `runAwsDifferential`, `installSdkProxy`, `resetTables`,
`snapshotTables`.

**Effect conventions** (what the proxy records, and what selectors match):

| Target             | Op                                                 | `call` payload                                                                                                                                                       | `result` payload                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DynamoDB:<table>` | the command name without `Command`, e.g. `PutItem` | `{ args: <command input> }`                                                                                                                                          | writes `{ args, result: { written } }`; `GetItem` `{ result: { found } }`; `Query`/`Scan` `{ result: { count } }`; a failed call (e.g. `ConditionalCheckFailedException`) `{ args, result: null, error }` |
| `SQS:<queue>`      | `delete`                                           | `{ args: { messageId, implicit: true } }` after a successful return (Lambda's implicit deletion); the point that admits crash faults between "handled" and "deleted" | `{ args, result: null }`                                                                                                                                                                                  |
| `SQS:<queue>`      | `dead_letter`                                      | `{ args: { messageId, attempts } }` (invocation `platform`)                                                                                                          | `{ args, result: null }`                                                                                                                                                                                  |
| `DynamoDB`         | `snapshot`                                         | —                                                                                                                                                                    | kind `snapshot`, `{ tables: { <table>: [items] } }`, items unmarshalled, after the last event                                                                                                             |

A committed write is a `result` with `result.written` of at least 1;
`dynamoWrite(table, op)` selects it. DocumentClient commands are recorded
under the low-level name (`PutCommand` as `PutItem`, `BatchWriteCommand` as
`BatchWriteItem`). A batch or transaction names every table it touches,
sorted and joined with `+` (`DynamoDB:audit+payments`), so a selector for
one table matches only single-table batches; a partially processed batch
counts the committed items. Binary attributes are recorded as `base64:…`.
Only the promise form of `send` is modelled: the callback form makes the
run `UNSUPPORTED` and the callback receives the error. The handler's own clients never reach
the network: calls are redirected to the local clients given to the platform,
matched by the client's class name (`DynamoDBClient`, `DynamoDBDocumentClient`).

**May import.** `@eutaxy/engine`, `@eutaxy/core`. Only these are declared in
`package.json`, and pnpm links only declared workspace dependencies, so an
import of any other package does not resolve. The project references in
`tsconfig.json` mirror the list; a test keeps the two in sync with the design.
The AWS SDK packages are peer dependencies: the user's handler brings them.

**Phase.** v0.4 (second platform). See `docs/design.md`
and `docs/roadmap.md`.
