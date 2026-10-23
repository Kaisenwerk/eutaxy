# @eutaxy/cloudflare

**Purpose.** Everything that knows about Cloudflare: binding proxies, the platform model, the binding allowlist, the Vitest integration.

**Public surface.** Scenario construction: `defineScenario`, `queue`,
`http`, `d1Schema`, `d1Write`, `d1Param`, `atMostOncePerKey`, `atLeastOnce`,
`atLeastOncePerMessage`, `external`, `fetchCall`, `httpResponse`,
`durableObject`. Running: `createCloudflarePlatform` (D1 proxy, Durable
Object stub proxy with the `durableObjects` test helpers from
`cloudflare:test`, queue delivery with at-least-once semantics, inbound
request delivery under the caller's retry policy, end-of-run D1 and
Durable Object snapshots), `check`, `expectHolds`, `runDifferential`.
State invariants: `d1Rows`, `durableObjectRows`, `everyRow`, `implies`,
`unique`, `queueAck`; `snapshotD1`.

**Effect conventions** (what the proxies record, and what selectors match):

| Target             | Op              | `call` payload                                                                                                                                               | `result` payload                                                                                                                    |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `D1:<binding>`     | `run`, `batch`  | `{ args: { sql, params } }`                                                                                                                                  | `{ args, result: { changes, lastRowId } }`                                                                                          |
| `Queue:<name>`     | `ack`, `retry`  | `{ args: { messageId, body, implicit? } }`                                                                                                                   | `{ args, result: { effective } }` (false when an earlier decision won)                                                              |
| `Queue:<name>`     | `background`    | `{ args: { pending } }` after the handler returned, when `waitUntil` work exists; the only point that admits `cut_off`                                       | `{ args, result: null }`                                                                                                            |
| `Fetch:<external>` | the HTTP method | `{ args: { url, method, headers, body, dedupeKey } }`                                                                                                        | `{ args, result: { status, effective, dedupeKey } }`; `effective` is false for a request replayed under a key the external had seen |
| `Queue:<name>`     | `dead_letter`   | `{ args: { messageId, attempts } }` (invocation `platform`)                                                                                                  | `{ args, result: null }`                                                                                                            |
| `Http:<path>`      | `response`      | `{ args: { requestId, method, path } }` when the handler returned (or threw: then status 500); admits only `crash_before`, the response the caller never saw | `{ args, result: { status, ok, body } }`, body parsed when JSON, else text cut at 1000 chars                                        |
| `Http:<path>`      | `background`    | as for queues, after the response                                                                                                                            | `{ args, result: null }`                                                                                                            |
| `Http:<path>`      | `gave_up`       | `{ args: { requestId, attempts } }` (invocation `platform`) when the caller's retries are spent                                                              | `{ args, result: null }`                                                                                                            |
| `D1:<binding>`     | `snapshot`      | —                                                                                                                                                            | kind `snapshot`, `{ tables: { <table>: [rows] } }`, recorded after the last event                                                   |

A committed write is a `result` record; `d1Write(binding)` selects results
with `result.changes` of at least 1.

**May import.** `@eutaxy/engine`, `@eutaxy/core`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4. See `docs/design.md` and `docs/roadmap.md`.
