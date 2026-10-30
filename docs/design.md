# Eutaxy — Design

Status: design baseline. Package: `eutaxy`. The unscoped name matches the
`eutaxy` command, so `npx eutaxy check` needs nothing else; the npm
organisation `eutaxy` owns it and also holds the `@eutaxy` scope, which the
internal, unpublished packages use, so neither name depends on one owner.
This document is the current design and is rewritten in place as it changes;
the phase plan is in `docs/roadmap.md`. Rationale for a choice sits next to
the choice.

## Summary

Eutaxy ships first as a deterministic simulation checker for Cloudflare
Workers and grows into a tool that ties simulation to machine-checked proofs
of a Worker's pure core. It runs unmodified Worker code with its bindings
wrapped, injects faults at every effect boundary, explores runs from a seed,
and checks invariants over the effect log. A failure comes back as a shrunk,
replayable trace plus a Vitest regression test that runs in workerd.

Eutaxy answers three questions, each with its own verdict:
1. **Does the code survive crashes, retries and concurrency?** The simulator
   explores fault points and interleavings within stated bounds and reports
   `VIOLATED`, `BOUNDED` or `UNSUPPORTED`.
2. **Is the business logic right for every input?** Specs on pure core
   functions are checked on the inputs the simulator produced, then on
   generated inputs, then proved by an optional prover (`PROVEN`).
3. **Does the running code follow that logic?** The `refines` invariant
   checks that every effect the shell performs matches what the core decided,
   on the state that was current when the effect committed.

## Design principles

Eutaxy is built the way it asks users to build Workers: a pure core, a thin
effectful shell, and honest verdicts that say what they rest on.
- **Functional core, imperative shell.** Scheduling, invariant checking,
  shrinking and verdicts are pure functions over plain data. Effects
  (bindings, globals, workerd, child processes) live at the edges.
- **Own the interfaces, adapt what is young.** Eutaxy owns the spec IR, the
  verdict model, the report schema and its own proof engines. Specs are
  written in TypeScript itself, so the user's own compiler checks them
  against the functions they describe and there is no second language to
  learn, track or extend. Third-party provers and future platforms plug in
  through interfaces and can be swapped or dropped.
- **Zero dependencies in the core.** `spec` and `core` import nothing
  outside the repo, so they stay translatable by a prover and safe to
  self-verify. The published package has no runtime dependencies at all.
- **Plain data at every boundary.** The public API, the JSON report and
  anything crossing a process boundary are plain objects and discriminated
  unions, never library types.
- **Verdicts never overclaim.** `BOUNDED` is never called verified, `PROVEN`
  always names its engine and assumptions, and anything Eutaxy cannot
  control makes a run `UNSUPPORTED` instead of passing quietly.
- **False alarms are bugs.** Every reported violation is replayed before it
  is shown, and the platform model must never allow behaviour the real
  runtime cannot produce.
- **Schedule points are effect boundaries.** The scheduler controls exactly
  the points Eutaxy intercepts: proxied binding calls, patched timers and
  patched `fetch`. Every other `await` resolves in program order. This is
  what "exhaustive" and "bounded" range over. Instrumenting every `await`
  would need a code transform and change the code under test; races between
  two non-effect awaits are a documented limit, and `refines` catches their
  stale-read consequences when they reach an effect.
- **One install for users.** Users add `eutaxy` and nothing else;
  heavy toolchains are opt-in downloads.

## Verdict model

Two kinds of verdict, kept apart in every report: simulation verdicts about a
scenario, and spec verdicts about a pure function.

| Verdict       | Applies to | Means                                                                   | SZS mapping        |
| ------------- | ---------- | ----------------------------------------------------------------------- | ------------------ |
| `VIOLATED`    | scenario   | A replayed, shrunk trace breaks an invariant                            | CounterSatisfiable |
| `BOUNDED`     | scenario   | No violation in any explored run within the stated bounds               | Eutaxy extension   |
| `UNSUPPORTED` | scenario   | The run touched something Eutaxy cannot control, or did not replay      | Unknown            |
| `CHECKED`     | spec       | Held on every input the simulator actually passed to the function       | Eutaxy extension   |
| `TESTED`      | spec       | Held on generated inputs                                                | Eutaxy extension   |
| `PROVEN`      | spec       | Proved for all inputs by a named engine                                 | Theorem            |
| `REFUTED`     | spec       | A counterexample was found at any rung                                  | CounterSatisfiable |
| `UNKNOWN`     | spec       | No rung could decide; carries `gave_up`, `unsupported` or `unavailable` | Unknown            |
| `CONFLICT`    | spec       | Two engines disagree (one proves, one refutes)                          | Eutaxy extension   |

The spec ladder runs in order: `CHECKED`, then `TESTED`, then `PROVEN` when a
prover is installed and the function is in that prover's accepted subset. A
counterexample at any rung is always an error; a weak, missing or
inapplicable prover only lowers the verdict.

Every verdict carries provenance: seed, bounds reached and schedule-point
count for simulation; engine name, version and assumptions for proofs.
Assumptions include opaque callees, the platform model, declared externals,
and engine-level choices such as how `number` is modelled, reported as the
engine states them. `CONFLICT` is never resolved automatically.

## Architecture and module layout

One repository of small modules with one rule: dependencies point down into
a pure core, and provers plug in from the side.

Four layers, top to bottom: entry points (the published facade and the
CLI); shell and services (`cloudflare`, `report`, `prover`); the
platform-neutral `engine`; and the pure, dependency-free core (`spec`,
`core`), which is also the self-verification target. Each layer may use any
layer below it. Prover engines attach to `prover` from the side, loaded at
runtime over a process boundary.

| Module            | Responsibility                                                                                                                                                                        | May import       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `spec`            | `SpecIR` and the combinators users write specs with (`forall`, `total`)                                                                                                               | nothing          |
| `core`            | Effect log, fault model, seeded PRNG, `Platform` interface, schedulers (seeded; exhaustive and partial-order reduction from v0.5), invariants including `refines`, shrinker, verdicts | `spec`           |
| `engine`          | Run loop, virtual clock, globals patching, per-run state reset, replay                                                                                                                | `core`           |
| `cloudflare`      | Binding proxies, platform model, allowlist, Vitest integration                                                                                                                        | `engine`, `core` |
| `aws`             | AWS SDK `send` proxy, SQS-to-Lambda delivery model, DynamoDB reset and snapshots; runs in Node                                                                                        | `engine`, `core` |
| `prover`          | `Prover` interface, the reader (a module and its spec file to `SpecIR`), spec ladder, aggregation                                                                                     | `core`, `spec`   |
| `prover-lean`     | First-party engine: pure-TypeScript subset to Lean 4, tactic stack, translation validation                                                                                            | `prover`, `spec` |
| `prover-smt`      | First-party engine: the same subset to SMT-LIB 2 for Z3; doubles, code-unit strings, datatypes; counterexamples replayed                                                              | `prover`, `spec` |
| `report`          | Text, versioned JSON, Vitest regression emitter                                                                                                                                       | `core`           |
| `cli`             | Commands, config, engine selection                                                                                                                                                    | all of the above |
| `eutaxy` (facade) | Public API at `eutaxy`, `eutaxy/cloudflare` and `eutaxy/aws`                                                                                                                          | all of the above |

Outside `packages/`, the repository holds `corpus/` (planted bugs,
differential scenarios, prover contracts; never published), `examples/` and
`docs/`.
- Boundaries are enforced by the package manager: each package declares
  exactly its allowed imports, and pnpm's isolated workspace links only
  declared dependencies, so a forbidden import does not resolve. TypeScript
  project references mirror the declarations for build order; a test keeps
  declarations, references and this table in sync. (Project references alone
  do not enforce this: imports by package name resolve through
  `node_modules` and are exempt from the composite file-list check.)
- Only `prover` imports the TypeScript compiler's API, from its reader
  alone; `typescript` is its peer dependency, and so the facade's.
- Only `cloudflare` knows about Cloudflare and only `aws` knows about AWS;
  each is a sibling package implementing `Platform`, and the engine, the
  invariants, the shrinker, the report and the CLI are shared.
- Only `engine` patches globals (`Date`, `Math.random`,
  `crypto.randomUUID`, `crypto.getRandomValues`, `performance.now`, timers,
  and later `fetch`); schedulers draw randomness from `core`'s PRNG and
  nothing else.
- `core` and `engine` never import provers; the CLI loads engines from
  config.
- The spec surface is the one interface `spec`, `prover`, the engines and
  the CLI share: `spec` holds its shape, `prover` reads and checks it, the
  engines translate it, the CLI finds it. A change to that interface
  touches all of them at once, which is the exception the two-package rule
  allows for a shared interface; the boundary itself does not move. The
  subset reader is shared the same way: a type the reader learns to read
  reaches every engine's emitter in the same change, which takes it or
  restricts the module to what it takes.

## Spec language, invariants and refines

Users write one spec per pure function and one spec file per scenario;
Eutaxy derives every check from those two sources.

**Function specs** are TypeScript, in a spec file beside each pure core
module: `decide.ts` has `decide.props.ts`, and a scenario's `specs` names
the modules. A spec file imports the module and `eutaxy/spec` and exports
one property per named export. `forall(f, { when, ensures })` quantifies
over the parameter types of `f`: `ensures` is the claim and the optional
`when` the precondition, both arrow functions over the same parameters,
typed by the user's own compiler as the parameters of `f`, so a spec that
does not match its function does not compile. Inputs failing `when` are
outside the claim, and `ensures` is evaluated only where `when` holds, so
a guard such as `c !== null` protects the reads after it. An optional
`sample` limits the inputs the `TESTED` rung draws, not the claim: where
evaluating the claim on large inputs costs too much (a function building
every schedule of sixteen levels of sixteen options), the sample keeps
draws small and the verdict names it, while `CHECKED` still evaluates
every input the simulator passed and an engine proves or refutes the
claim for every input. A bound in `when` would instead weaken the claim
the engines prove. `total(f)`
claims termination on every input. Binder domains are the parameter
types: a record, a nullable record, a union of string literals or a tagged
union is a binder as a `number` is, and the claim names the function by
value, so renaming it cannot detach its spec. A claim's body is ordinary
TypeScript over the same subset the engines read: comparisons, `&& || !`,
the conditional operator, field reads and calls to the module's functions.
`number` is the double type and is drawn and modelled as declared; a claim
that holds only for integers says so in `when` (`Number.isInteger(n)`,
`0 <= n`). Specs live beside the module rather than in it so the core
keeps importing nothing and the Worker's bundle carries no spec.

```ts
import { forall } from "eutaxy/spec";
import { decideRefund } from "./decide.ts";

export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
```

Eutaxy reads a module and its spec file into its own `SpecIR`, plain data
with typed binders, on the Node side of a check. The reader asks the
TypeScript compiler through its API (7.1, which restored the programmatic
API 7.0 shipped without): `typescript` is a peer dependency of `prover`
as Vitest is of the facade, one compiler process serves a Node process,
and each read compiles the files it is given over an in-memory layer on
top of the host's files, so binder types are whatever the user's compiler
resolves them to: an alias declared later in the file, a generic alias
instantiated, an inline object type, a type imported from another file.
What stays Eutaxy's is the subset's meaning (its integers and doubles,
its list model, narrowing by a null check or by a union's tag, structural
recursion, the expression tree the
engines translate) and the naming of what the engines declare: a declared
type by its name, an instantiated or inline one as the compiler prints
it. The engines never touch the compiler API, so the reader is the one
place a compiler change lands. The reader follows the compiler's releases
and is pinned exactly in the workspace. Inside workerd the spec file is
imported and its properties evaluated directly, so nothing is generated
and nothing is `eval`ed. The spec surface is the one breaking change of
`0.7.0`: `0.6.x` reads Lemma annotations in JSDoc, which `0.7.0` drops
with a migration note. Specs were Lemma because its grammar had a neutral
home and a conformance corpus; but its domains are primitives only and
bind to parameters by name, which no real core signature fits, and
widening it would have meant forking it.

**`CHECKED`** evaluates a property on the inputs the simulator actually
passed. While a scenario is explored, calls into the functions its spec
files name, from outside their module, are observed through the module's
namespace (Vite gives it configurable exports, which is what Vitest's own
spies rely on) and their arguments recorded. Core functions are
synchronous; one that returns a promise makes the run `UNSUPPORTED`. Each
distinct recorded call is one assignment; one failing `when` is discarded.
A false claim, or an exception from `ensures` other than a malformed
property (a result that is not a boolean, which the user's compiler should
already have refused), is `REFUTED` with the call it came from. Holding on
at least one assignment is `CHECKED`, and the verdict says on how many;
none is `UNKNOWN` (`gave_up`). `total` is `UNKNOWN` (`unsupported`) at
this rung, since termination is not observable on samples. Exploration
stops at a scenario's first violation, so a run that ends `VIOLATED`
passes fewer inputs than one that ends `BOUNDED`.

**`TESTED`** evaluates the same property on assignments drawn from the
parameter types, after the exploration and with its seed, so the same seed
draws the same assignments on every machine and a verdict carries the seed
it rests on. Each property derives its own stream from the seed and its
name, so adding a property does not change what the others see. The first
assignments are the edges, before any random draw: each binder's edge
values (the range's ends, zero and one, `NaN`, the infinities and `-0` for
doubles, `-0` among the integers too, the empty string, both booleans,
every member of a union, records built from their fields' edges, distinct
and at most 64 so that nesting does not multiply them), walked side by
side once in step, so equal edges meet (`Infinity - Infinity`), and once
rotated, binder `j` starting `j` places in, so binders of one type also
differ. Every edge of every binder is tried, however many there are (a
union of a hundred literals tries each); the input budget below then
applies, at least half of it to random draws, so many edges never crowd
out the values between them. A claim false on one edge value is thus
refuted under every seed, while one false only on a combination of edges
the two walks do not pair rests on the random draws. Random draws then
follow, biased the way bugs are distributed: most numbers are small integers, some
are medium or large, a few are the range's ends, and doubles include the
fractions, the magnitudes and the special values (`NaN`, the infinities,
`-0`), since `number` is the JavaScript type; integers stay within what a
double holds exactly; bigints go beyond it; strings are short texts over
letters, digits, punctuation and a few multi-unit characters, and where
`when` tests a parameter against a whole-string regex they are drawn by
walking the pattern (literals, classes, groups, alternation, quantifiers,
anchors), with sampling over the pattern's characters as the fallback for
syntax the walker refuses (lookaround, backreferences, property escapes);
the real `RegExp` has the last word on every draw. A union of literals
draws each literal, a nullable type draws `null` among the values, a
record is drawn field by field, a tagged union draws every tag, and an
array (`T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`) is mostly
short, up to sixteen elements, with an element repeating an earlier one a
quarter of the time, since claims keyed on distinct elements break on a
repeat; its edges are the empty array, one of each element edge, and one
element twice, and it shrinks by dropping elements before shrinking them,
every copy of a value at once. Neither engine translates arrays yet. Each
evaluation of a property gets its own copy of the input's plain data
(arrays and records), so code under test that mutates what it is given
(`xs.sort()`) changes neither the counterexample printed nor the
candidates shrunk from it. Where
`when` compares a parameter with a constant (`0 <= n`, `n < 5`), the draws
are steered into that range, as an interval guard would, so a precondition
is met rather than missed; and since preconditions relate binders
(`refunded + amount === captured`), which independent draws would satisfy
once in thousands, a later integer binder is sometimes drawn equal to an
earlier one or to the sum or difference of two. Assignments are counted distinct, as `CHECKED`
counts them (two booleans are two inputs, however often they are drawn).
The rung stops at a set number of distinct assignments inside the claim
(100 unless configured), or after twenty times as many draws, which is
`UNKNOWN` (`gave_up`) when none was inside: preconditions sampling cannot
meet lower the verdict, never pass. A property that could not be evaluated
on any input, the simulator's or a drawn one, is malformed and stays
`UNKNOWN` (`unsupported`) whatever the other rung found: inputs that
happen to miss the fault do not make the property look sound. An
assignment where the claim is false is shrunk, one binder at a time toward
zero (or the nearest end `when` admits), shorter and plainer strings,
`false`, `null` and the first literal of a union, as long as the property
still fails, and reported as `REFUTED` at the `TESTED` rung with the
shrunk assignment; it has no call, since the simulator did not make one.
The rung calls the function outside the simulator, so it assumes the
function is pure, and a function that does not terminate on a drawn input
hangs the check; `total` stays `UNKNOWN` here.

The ladder runs `CHECKED`, then `TESTED`, inside workerd; the `PROVEN`
rung runs after them on the Node side of `eutaxy check`, where an engine
can be spawned, when `--prover <name>` names one. A counterexample at
either simulator rung is `REFUTED`, the simulator's first, with its call.
When both hold the verdict is `TESTED` and says on how many of the
simulator's inputs it also held; when sampling gives up, `CHECKED` stands
and says why it is not `TESTED`; when neither decided, one `UNKNOWN` names
both reasons. Engines are folded in by `aggregate`: one engine proving
lifts the verdict to `PROVEN`, the lower rungs' counts kept beside it
(`total`, which no simulator rung decides, is proved this way); an engine
refuting where nothing else did is `REFUTED` at the `PROVEN` rung; one
proving and another refuting, or an engine proving against the simulator's
own counterexample, is `CONFLICT`, which fails the check like a refutation
and is never resolved automatically; an engine that gave up, could not run
or does not take the function leaves the verdict as it was, with why among
the assumptions, so a listed engine that is not installed costs nothing but
the proof. The
verdict kinds and `rung` values a report can carry grow within a schema
version; a field removed or re-typed bumps it.

**Scenario specs** (`*.sim.ts`) are TypeScript files whose default export is
a `ScenarioSpec`: plain data naming the Worker (entry and wrangler config),
how to drive it, the state to set up before each run, the declared
externals, the invariants and the bounds. The platform-neutral shape lives in
`core`; the parts only a platform understands (`drive`, `setup`) travel as
`PlatformData`, JSON tagged with a `kind`, built by typed helpers in the
platform package. For Cloudflare:

```ts
import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  queue,
} from "eutaxy/cloudflare";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "queue-duplicate-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
```

A scenario has one drive. `queue(name, messages)` drives the `queue()`
handler. `http(requests, { retries, retryOn })` drives the `fetch()` handler:
each request (method, path, headers, JSON or text body) is an event like a
message, delivered under the same faults; the response the handler returns
is recorded as an effect (`Http:<path>`, op `response`) whose one admitted
fault, a crash before it, is the response the caller never received. The
caller's retry policy, not Cloudflare's, decides redelivery: a webhook
provider resends until it gets a 2xx (`retryOn: "non-2xx"`, the default)
or only on failures and 5xx (`"5xx"`), up to `retries` times; a browser-like
caller has `retries: 0`. An uncaught exception is a 500 response.
`httpResponse(path, { ok })` selects responses for invariants such as "one
2xx per request", and `atLeastOncePerMessage` accepts either drive.

Invariants are plain data over the effect log, checked by pure functions.
An _effect selector_ picks records by target, op, kind and payload fields;
a _key_ is a dot path into the payload. The library starts with
`atMostOncePerKey` (no two selected effects share a key) and `atLeastOnce`
(every expected key appears), which the first planted bug needs, and two
_state_ invariants over a snapshot of D1 taken after the last event and
recorded into the log: `everyRow` (every row a state query selects satisfies
a list of column conditions) and `implies` (every selected effect, keyed by
a path into its payload, has a row whose column equals that key). `unique` (no
two selected rows share a value) and `references` (every selected row has
a row in another snapshot that points at it, as a foreign key does: no
R2 object without the D1 row that names it) cover the state on their own. A missing
snapshot is a violation, never a silent pass. Effect payload conventions per
binding are documented in the `cloudflare` package README. Every payload
value goes through one summarizer, core's `toJson`, which is exact for JSON
data and writes everything else the same way on every machine (bigints as
their digits, Dates in ISO form, Sets and Maps as arrays, cycles as `<nested>`); a
platform adds its own encodings in front of it (AWS keeps binary values in
base64, so two binary keys stay distinct).

**`refines`** is the bridge between the two. The observed calls are also
recorded in the effect log as decisions (`Core:<function>`, payload
`{ args, result }`) of the invocation that made them. `refines(name,
decision, effect, { follows, state })` checks that every selected effect
carries out the latest decision of its invocation (an effect with none is
a violation, so forgetting to list the module never passes quietly),
agrees with it on `follows` (pairs of payload paths), and, with `state`,
rests on a `read` its invocation made before the decision and was not made
stale: no other invocation's `write` to the same `key` committed between
that read and the effect. A call that threw is not a decision, and a
function name observed in two spec modules is an error, since decisions
are logged by name.
That last check is what catches a lost update, where every decision is
right for the state it saw. It does not replace system invariants: a shell
can follow the core faithfully and still break a system property, so both
are always checked.

**Externals declare their guarantees and script their replies.** Outbound
`fetch` never reaches the network. A scenario declares each external the
Worker talks to with its host (exact or a `*.suffix` pattern), optional
scripted responses matched by method and path (every request gets 200 and
an empty body when none are scripted), and what it guarantees under
retries, for example `dedupeBy: "Idempotency-Key"`: a request repeating an
earlier one's key gets the earlier reply and is recorded as not effective,
so invariants over `Fetch:<external>` count only effective requests. Each
request is an effect point with every fault available, including the
ambiguous outcome where the request committed but the caller saw an
error. A request to an undeclared host, or one no scripted reply answers,
makes the run `UNSUPPORTED`. A verdict is only as good as these
declarations, so they are listed among its assumptions.

## Fault model and platform model

The fault model is platform-neutral and lives in `core`; what Cloudflare
promises lives in one reviewable module, `cloudflare/model`, separate from
the binding proxies.

Faults injected at every effect boundary:

| Fault               | What happens                                                                                                                                                     | Why it matters                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Crash before effect | The effect never happens; the invocation dies                                                                                                                    | Lost work, missing writes      |
| Crash after effect  | The effect happened; the invocation dies before continuing                                                                                                       | Duplicate effects on retry     |
| Ambiguous outcome   | The effect committed but the caller sees a timeout or error                                                                                                      | Breaks most retry logic        |
| Error               | The effect fails cleanly with an error                                                                                                                           | Error-handling paths           |
| Redelivery          | A queue message or alarm is delivered again; an inbound request is resent by its caller                                                                          | At-least-once semantics        |
| Cut-off             | The acknowledgement or response was sent; work scheduled with `waitUntil` that has not started is lost, and an effect in flight commits without its continuation | Background work that never ran |

**Platform semantics to encode, with a documentation source for each:**
- D1: `batch()` is all-or-nothing; separate `run()`/`first()`/`all()` calls
  are each one effect and can be cut between statements; prepared statements
  are not effects until executed.
- Queues: at-least-once delivery; per-message `ack()`/`retry()`, batch
  `ackAll()`/`retryAll()`; a crash mid-batch redelivers every unacked
  message; `max_retries` and dead-letter queues.
- Inbound requests: one invocation per attempt; an uncaught exception in
  `fetch()` is answered with a 500 (Workers runtime); resends follow the
  drive's declared caller policy, since Cloudflare itself never retries an
  inbound request. The policy has a count (`retries`), what counts as
  failed (`retryOn`), the virtual delay before each resend (`delaysMs`) and
  how long the caller waits for an answer (`deadlineMs`). The caller
  decides at the response point, or at its deadline (a virtual timer set
  when the request is sent) if the handler has not answered by then, never
  when the handler's background work ends: the resend is queued at that
  moment (`RunHooks.enqueue`, with the virtual time it is due), so with
  concurrent invocations it can start while the first attempt still runs.
  The differential runner rejects drives with caller timing until it
  models it on both sides. Because the handler's own time is virtual, a
  late answer is either an answer later than `deadlineMs` in virtual time
  or the `ambiguous` fault at the response point, offered only when the
  drive declares a deadline: sent, counted as failed by the caller, and
  the handler carries on. A delayed event waits until the virtual clock
  reaches it; the engine moves the clock there once nothing else can move,
  firing timers due before it first.
- Durable Objects (v0.5): input gates block new events during storage
  operations but not during outbound `fetch`; output gates hold responses
  _and outgoing requests_ until pending writes are confirmed; consecutive
  synchronous writes with no intervening `await` coalesce into one atomic
  transaction; `blockConcurrencyWhile` is honoured; the SQLite storage API
  is synchronous; an alarm whose handler throws is re-run from the start.
  Eutaxy does not re-implement any of this. The objects are the real ones
  workerd runs, as D1 is Miniflare's real SQLite, so storage, transactions
  and gates are the runtime's own; workerd also refuses to construct a
  `DurableObject` subclass outside the runtime, which rules out running
  the class against a model. Eutaxy proxies the boundary a Worker crosses:
  each stub call is one effect, where `crash_before` and `error` mean the
  call never reached the object, `ambiguous` that the object committed and
  the answer was lost, and `crash_after` that the caller died after the
  call. Through the Cloudflare Vitest plugin's test helpers each object is
  cleared, seeded from the scenario's `durableObject` setup and evicted
  before a run, so it starts from storage alone, and its storage is
  snapshotted after it (rows `{ key, value }` per object name). Alarms are
  taken over on each object's storage, inside transactions too, so none is
  scheduled on the real clock, whose time is far ahead of the virtual one,
  and they fire in virtual time: Eutaxy keeps one alarm per object (a later
  `setAlarm` replaces it, a transaction's applies on commit of the attempt
  that commits, an alarm set in the constructor is moved over unless one
  is still pending, which makes the run `UNSUPPORTED` because natively the
  constructor would have seen it, as does a rebuilt constructor that reads
  the alarm while one is pending (reads before the takeover are recorded
  on the storage prototype); each change starts a new generation, so
  an alarm or retry it supersedes is dropped before any fault applies),
  it survives eviction, and when the
  run reaches its time the object's `alarm()` runs as one effect. Alarms
  run at least once (Cloudflare, Durable Object Base API): `crash_before`
  means it never ran, `crash_after` that it ran and committed but counts
  as failed (either crash also drops the instance, so in-memory state is
  lost as in a real crash), `error` that it threw, and a failed alarm is
  retried after
  2 s, 4 s, 8 s, up to six retries and `maxRedeliveries`, with
  `retryCount` and `isRetry`. Several schedules over one alarm (the
  pattern the Agents SDK uses) work as written. An object that keeps
  re-arming fires at most `alarmsPerObject` times per run (default 3). A
  `setAlarm` inside `transactionSync()` makes the run `UNSUPPORTED`. A
  crash injected inside an object's own work resets the object with
  `ctx.abort()`, as a crash does, called where the crash happens because
  abort() works only from inside the object. In a concurrent run an
  effect the object makes during a call (its own `fetch`) is a turn: the
  input gate is open while the object awaits outbound I/O (Cloudflare,
  Durable Objects: input and output gates), so another call into the
  object may run first, and the call waits on that effect meanwhile
  instead of counting as I/O in flight (a call awaiting several such
  effects is waiting only while all of them are parked). workerd refuses
  to settle a promise made inside an object from outside it, so such an
  effect waits by polling a flag with real zero timers made inside the
  object, and the scheduler is never woken from inside an object, where it
  would resume in the object's I/O context. While an object holds its
  input gate with `blockConcurrencyWhile` nothing else can enter it, and
  even its timers wait at the gate, so its effects run at once then
  (`EffectOptions.mayPark`). Current limits: storage operations are not
  turns (the input gate holds them, so this is the runtime's behaviour);
  the object's own binding calls are not recorded, and an object reached
  only through another object's binding makes the run `UNSUPPORTED`, as do
  `newUniqueId` (random), `jurisdiction()` namespaces and a namespace the
  scenario does not reset (no `durableObject` setup). An object no call
  reached is snapshotted from its seed without being constructed. Reset
  constructs each object outside the simulation, with the network blocked:
  a constructor that makes a request fails the reset. A stub property can
  be called (a method) or awaited (an RPC getter); either is one effect.
  A result that is not plain data (an RPC capability) makes the run
  `UNSUPPORTED`, since calls on it would bypass the proxy.
- R2: reads, writes, deletes and listings are strongly consistent, the
  last writer to complete wins, a conditional `put` whose precondition
  fails stores nothing and returns `null`, and a conditional `get` whose
  precondition fails returns the object without a body (Cloudflare, R2:
  Consistency model, Workers API reference). The bucket is Miniflare's
  real one; each `put`, `delete`, `get`, `head` and `list` is one effect
  (writes take `crash_before`, `crash_after`, `ambiguous` and `error`,
  reads all but `ambiguous`). A body is read inside its `get`'s effect,
  since reading it later is I/O the run cannot see, and handed back as an
  object with the same fields and body methods. Objects carry a random
  `version` and the wall-clock `uploaded`; the proxy gives each version a
  stand-in, counted in the order the run first sees versions, and the
  virtual time it first saw it, and every later answer about that version
  uses them, so traces stay byte-identical. Each `r2Bucket` setup step empties its
  bucket and seeds it before a run, and its objects are snapshotted after
  it (`R2:<binding>`, table `objects`: key, size, etag, metadata, and the
  text of a small text object). A body the proxy handed out and the Worker
  passes back to `put` (copying an object) is written from its buffered
  bytes, since the runtime's `put` needs a stream of known length.
  Multipart uploads make the run `UNSUPPORTED`, as do conditions on the
  upload time (`uploadedBefore`, `uploadedAfter`, `If-Modified-Since`):
  the store would compare its real time, not the stand-in the Worker saw.
  So does an R2 binding without a setup step.
- Workflows: an instance runs its class's `run(event, step)`; each
  `step.do` is retried on failure (by default 5 retries, 10 s apart with
  exponential backoff), its result is persisted under its name and count,
  and the engine may restart an instance, re-running `run` from the start
  with the persisted results, so code outside steps can repeat and a step
  whose result was not persisted runs again (Cloudflare, Workflows: Rules
  of Workflows, Sleeping and retrying). `create` with an id that exists
  throws `(instance.already_exists)`, and `get` of an unknown id throws
  `instance.not_found` (Workers API; the messages are Miniflare's). Here
  the engine is a model, the one exception to running the real local
  implementation: the local engine runs steps on its own real-time clock
  and retry loop, so it cannot be restarted between a step committing and
  its result being persisted, which is the case that matters. The
  instance runs the scenario's own class, constructed with the proxied
  env: workerd refuses to construct a `WorkflowEntrypoint` subclass
  without a native `ExecutionContext`, so for that one synchronous
  `new` the class's base is a plain stand-in that sets `ctx` and `env`
  (the class's own constructor and field initialisers run as written;
  `WorkflowEntrypoint.prototype` holds no methods), and the base is put
  back at once. The binding is proxied and never reaches the real engine:
  `create` is one effect (`crash_before` and `error`: not created;
  `ambiguous`: created, the caller lost the answer; `crash_after`: the
  caller died after it) that queues the instance as an event, and an
  instance is one invocation per engine attempt. Each `step.do` attempt
  is two asynchronous effect points (the engine reads and persists the
  step asynchronously, so other events may run between steps) around its
  callback, which runs as the instance's
  own code (its effects are ordinary effects of the invocation and its
  timers are virtual): `step` before it, where `crash_before` restarts the
  instance before the step runs, and `step_result` after it, where
  `crash_after` restarts it after the step ran and committed but before
  its result was persisted (so it runs again), and `ambiguous` is an
  attempt that ran but counted as failed (a timeout, which code sees as
  the engine's `WorkflowTimeoutError`), retried after its
  delay in virtual time. A callback that throws is retried the same way,
  up to its limit and `maxRedeliveries`; a `NonRetryableError` (an `Error` so
  named, or whose message starts so, as the engine checks) is rethrown as
  thrown and neither retried nor persisted, so after a restart its
  callback runs again, as in the engine. A step's config is merged with the defaults field by
  field and the backoff applies to a delay function's value too, as in
  Miniflare's engine; the model keeps the documented 10 s delay where the
  local engine waits 1 s. An instance restarts after each crash, so at
  most `maxFaultsPerRun` times; a step's attempt count and the retry
  config its first attempt resolved are persisted with it, and a pending
  sleep's or retry's deadline before it waits, so a restart goes on
  counting, keeps the config and waits only the rest. As in Miniflare,
  `create` without params gives an empty payload (an explicit `null`
  stays `null`), an id is up to 100 letters, digits, `-` and `_`, not
  starting with `-` (otherwise "Workflow instance has invalid id"), and
  `sleepUntil` a past time throws; durations are read as the
  engine reads them (a year is 365.25 days, a numeric string is
  milliseconds), and a step marked `sensitive: "output"` keeps the setting
  and has its output redacted in the trace; a step name over 256 characters or
  with a control character, or a step config the engine rejects (a zero
  timeout, a negative limit, an unknown backoff) is the engine's fatal error, and makes the run
  `UNSUPPORTED` too, since whether code can catch it is not documented. `event.workflowName` is the name the
  `workflow` setup step gives (the wrangler config's `name`); reading it
  without one makes the run `UNSUPPORTED`. `step.sleep` and `step.sleepUntil` wait in
  virtual time and, like steps, are not repeated after a restart; a sleep
  is known by its name and duration, as the engine keys it, so a restart
  that computes another duration sleeps again. Each
  instance's id, status, params and output are snapshotted after the run
  (`Workflow:<binding>`, table `instances`). Current limits: step
  timeouts are not measured (a timed-out attempt is the `ambiguous`
  fault); a finished `sleepUntil` replayed after its time (Miniflare's
  engine throws there, and production behaviour is not documented), a step
  returning a stream or more than about 1 MiB (the engine refuses it, and
  Eutaxy cannot measure the stored size exactly), a retry delay function that throws, `waitForEvent`, `sendEvent`, rollback handlers, `createBatch`
  and pausing, resuming, terminating or restarting an instance make the
  run `UNSUPPORTED`, as does a Workflow binding without a `workflow`
  setup step naming its class.

**Fidelity rules:**
- Proxies intercept calls but execute them against the real local
  implementation (Miniflare's D1 and storage), so SQL and storage semantics
  come for free. The Workflows engine is the exception (see above); the
  corpus checks the model against the local engine on fault-free runs.
- An allowlist of proxied bindings; anything else (Cache API, service
  bindings, AI, Hyperdrive, raw sockets) makes the run `UNSUPPORTED`.
- Determinism-breaking APIs that are not virtualised (`WeakRef`,
  `FinalizationRegistry`) also make the run `UNSUPPORTED`; `performance.now`
  is virtualised along with the clock.
- Production-only behaviour the simulator cannot see (D1 read replication,
  real queue batching, real latency) is documented as out of scope.

## Running inside workerd

Eutaxy runs through the user's own Vitest setup with the Cloudflare Vitest
plugin, so the TypeScript loader, workerd and bindings all come from the
user's existing configuration. The engine relies on three documented
properties of that integration and names them as assumptions in every
verdict:
1. The main Worker runs in the same isolate as the test, so the engine's
   global patches apply to it.
2. Storage isolation is per test file. Exploration runs many schedules
   inside one test, so the engine resets bindings and Durable Object memory
   between runs itself, using the integration's reset helpers.
3. Module caches are reused and no fresh-module-per-run API exists, so
   module-level state cannot be reset. Before reporting `BOUNDED` the
   engine replays the first exploration runs in reverse order and compares
   their logs with the originals; any difference downgrades the verdict to
   `UNSUPPORTED` with cause `module_state_leak`. The pass costs two extra
   runs by default and can be sized or disabled per check.

A run's _schedule_ is the list of injected faults, each keyed by invocation
and by the effect's ordinal within that invocation (not by a global index),
so a schedule stays valid when other invocations are removed. Replay follows
a schedule exactly; exploration records one.

**Seeded exploration** places faults by position, not by a chance at each
point. The first run injects none: it checks the scenario as it runs
without faults and counts its _eligible_ points (effect points that may
take a fault). Every later run draws from the seed how many faults it
injects (one up to `maxFaultsPerRun`), at which eligible points and, for
each, a kind among its allowed faults. The first fault is uniform over the
most points a run without faults has had, which a run reaches before its
first fault; the others come after it, uniform up to the most points any run
has had, since an earlier fault (a redelivery) can make a run longer. Every point is then as likely to be faulted
as any other: a fault that a chance at each point would place on the
first point it reaches can land on a Workflow's last step just as often.
A chosen position that a run does not reach is not injected.
`faultProbability` is the share of those later runs that inject faults
(default 0.9). The runs it leaves without faults keep measuring the path
without faults, which can vary with the seed (randomness, the order of
turns): a first run that happened to take a short path does not hide the
deeper points of a longer one.

**Exhaustive exploration** (`explore(..., { exhaustive: true })`, `eutaxy
check --exhaustive`) runs every schedule within the bounds once instead of
drawing schedules from the seed. A run's nondeterminism is a sequence of
choices (a fault or none at each effect point that may still take one, the
next turn at each scheduling decision); runs are deterministic, so the
enumerator walks the tree of choice sequences depth first, re-running from
the scenario's reset with an ever longer forced prefix, and a run that
makes different choices after the same prefix makes the verdict
`UNSUPPORTED` (`not_replayable`). Such a schedule records its turn picks
(`Schedule.turns`), so replay, shrinking and regression tests follow them
rather than the seed. The count is checked against closed forms in the
engine's tests: k events of n effects interleave in
(k(n+1))! / ((n+1)!^k k!) ways (each event starts with a turn, in order), m
faults of f kinds on kn points are placed in sum_{j<=m} C(kn, j) f^j ways,
and with both the count is the product. Partial-order reduction is on by
default: sleep sets (Godefroid, 1996) skip an order of two turns once the
other order has run when they belong to different invocations and their
effects have different targets; starting an event is dependent on
everything. This assumes code between an invocation's effects shares no
state with other invocations except through effects and the virtual
globals, which the verdict states. A turn is known by its parked effect's
target before it runs, but it may do more: perform a synchronous or nested
effect on another target, queue an event (the pending queue's order is
shared), or read the time or randomness, or schedule a timer (every effect advances the clock and every draw the random stream,
so such code can tell two orders apart). The run notes any of these in a
turn other than an event's start (an effect's own I/O included),
and once a run has, it is checked as usual and the enumeration starts
again over every order with the reduction off. Dependence learned while
running would need dynamic partial-order reduction to stay sound. Every exhaustive verdict, of any kind and in the
text report as in the JSON, reports whether enumeration completed, how many
schedules ran (the run that turned the reduction off among them), and
whether the reduction stayed on.

**Concurrent invocations.** With `maxConcurrentInvocations` above 1, up to
that many invocations are in flight, as concurrent requests are in one
isolate ("other requests may (or may not) be processed during awaiting any
`async` tasks", Cloudflare, How Workers works) and concurrent queue
consumers are up to `max_concurrency` (Cloudflare, Consumer concurrency).
Each
asynchronous effect is a turn: the invocation parks there, and once every
invocation in flight has parked, finished or gone idle, the engine lets
one parked invocation perform its effect and run to its next one, or,
while a slot is free, starts the next event; timers fire only when nothing
else can move; an invocation that waits
on nothing Eutaxy can see makes the run `UNSUPPORTED`. The pick among
parked invocations comes from a stream seeded by the run's seed, separate
from fault decisions, so replay makes the same picks and the schedule
needs no record of them. Synchronous effects (an ack, the response point)
are not turns. Each delivery runs in its own async context
(AsyncLocalStorage), so `RunHooks.running` names the invocation whose code
is executing even when a promise shared between invocations resumes one
during another's turn; a host without it gets `UNSUPPORTED`. A platform
declares `concurrent` once nothing it shares between deliveries depends
on which invocation is running; the Cloudflare
platform does, the AWS platform does not yet. A shrunk schedule keeps the
seed, so removing a fault can change later picks; the shrinker keeps a
candidate only when replay still violates, as for any other change.

The _shrinker_ takes a replayed violation and tries, smallest change first,
removing one fault and then removing one input event, keeping a candidate
only when replay still violates the same invariant for the same keys.
Invariants whose expectations were derived from the input (per-message
`atLeastOnce`) are re-derived for the remaining events, so a shrunk scenario
cannot "violate" merely because its expectations went stale. Randomness is
one stream per run, so when the keys are random ids (an object stored under
`crypto.randomUUID()`), removing an earlier event shifts the ids drawn after
it and the candidate is dropped; such a violation can keep more events than
it needs. The verdict reports the kept events, the shrunk schedule and the
replayed shrunk trace.

**Virtual clock and globals.** For the duration of a run the engine
replaces `Date`, `Math.random`, `crypto.randomUUID`,
`crypto.getRandomValues`, `performance.now` and the timer functions with
deterministic versions derived from the run's seed. Time starts at
2026-01-01T00:00:00Z and advances one millisecond per completed effect and
to each timer's due time when it fires. Timers fire only while the
invocation is idle, meaning no effect is in flight, in due order, so they
never race real I/O. Platforms wait for handler and background promises
through the engine's `settle`, which lets real I/O complete, fires due
timers, abandons a crashed invocation, and marks the run `UNSUPPORTED` when
user code waits on something Eutaxy cannot see. Web Crypto calls
(`crypto.subtle`) are real work the handler waits on but not effects: the
engine waits for them like an effect's I/O, unrecorded and never faulted,
so timers and turns are never decided while one is running; that matters
for webhook handlers that verify a signature. An effect whose real I/O
outlasts the scenario's `budgetMs` is treated as hung and the run is
`UNSUPPORTED`, naming the effect, instead of waiting forever. The globals
are restored after every run, including on failure. Code that captured `Date.now` or
`Math.random` at module load escapes the patch; that is a documented limit.

Each run resets D1 by dropping every user table and re-applying the
scenario's schema through the real binding, outside the effect log. Queue
messages are delivered one at a time; an unacknowledged message is
redelivered up to `max_retries` (default 3) and within the scenario's
`maxRedeliveries`, then dead-lettered, which the log records.

The CLI's `check` command generates a test file and invokes the user's
Vitest, rather than hosting workerd itself. That keeps the CLI free of
runtime dependencies. Concretely, `eutaxy check <scenario.sim.ts>` writes a
`.eutaxy/` directory beside the scenario holding a test that performs the
check inside workerd and a Vitest config with the Cloudflare plugin pointed
at the wrangler config found beside the scenario (or given with
`--wrangler`). The test holds only the Vite globs (they resolve at build
time, so they must be written in it) and one call to `checkInWorkerd`, a
typed function of the `cli` package that resolves the Worker and schema
files from the scenario's own `worker.entry` and `setup`, observes the
modules the scenario's `specs` name, runs the check and checks the specs.
The test stores what it returns in its Vitest task meta, and the CLI reads it back through Vitest's JSON
reporter: nothing depends on console output. The CLI then prints the text
report or the JSON report, writes `<name>.regression.test.ts` on a
violation, removes `.eutaxy/`, and exits 0, 1 or 2 for `BOUNDED`,
`VIOLATED` or `UNSUPPORTED`. In development the CLI runs its TypeScript
sources directly on Node 24, which is why relative imports name `.ts` files.

## The AWS platform

The second platform is AWS Lambda consuming SQS with DynamoDB, in
`packages/aws`. It shares everything above the `Platform` interface and
differs from Cloudflare in three ways.
- **Runtime.** Lambda handlers run in plain Node, so the platform needs no
  runtime emulator: the engine, the handler and the local services share
  one process. The handler receives an SQS event with one record and a
  Lambda context whose request id and clock are virtual.
- **Effect boundary.** Every AWS SDK v3 client extends one Smithy `Client`
  whose `send` is the single point every call passes through. For the
  duration of a run it is replaced: the call becomes an effect point
  (`DynamoDB:<table>` with the low-level command name as op, DocumentClient
  commands normalised to it, a batch or transaction naming every table it
  touches joined with `+`; all faults available for
  writes), and the real work is sent through a local client the platform
  was given, matched by the calling client's class name. The handler's own
  clients, built at module scope the way Lambda code does, never reach the
  network. A client class without a local counterpart makes the run
  `UNSUPPORTED`. DynamoDB semantics, including conditional writes, come from
  the local DynamoDB the user runs (DynamoDB Local, LocalStack, or dynalite
  in this repository's tests).
- **Delivery model**, as documented by AWS for SQS event sources: a
  successful return deletes the message (recorded as an implicit `delete`
  effect, the point where crash faults land between "handled" and
  "deleted"), a thrown error or a reported batch item failure leaves it to
  be redelivered, and after the queue's `maxReceiveCount` deliveries it is
  dead-lettered.

Two consequences of sharing a process with the local service are built in.
Reset and the end-of-run snapshot run with the real globals installed, so
an in-process DynamoDB keeps its own timers; and while any effect performs
its real I/O, timers the SDK schedules inside that I/O are real, because
SDKs back off and time out with them, while timers the handler schedules
meanwhile stay virtual. The engine tells the two apart with Node's
`AsyncLocalStorage`, which follows the SDK's promise chains and I/O
callbacks but not the handler's own continuations; where it is unavailable
(workerd without Node compatibility) every timer stays virtual, which the
Cloudflare bindings do not need. The clock, `Date` and randomness stay
virtual throughout.

## Provers

Proving is optional. `CHECKED` and `TESTED` need no engine, and a listed
engine that is not installed only lowers a verdict to `UNKNOWN`. Every
engine, first-party or not, sits behind one interface Eutaxy owns and runs
over a process boundary.

Two engines are first-party, so that the strongest verdict never depends
on an external project's roadmap. They read the same subset and the same
`SpecIR`, and they divide the work by what each decides well: records,
unions, nullable types and doubles reach `PROVEN` through the SMT engine
first; recursion, induction and Eutaxy's self-check are Lean's. A user
lists either or both.

**First-party engine (`prover-lean`).** Eutaxy's TypeScript-to-Lean 4
engine. It accepts a defined pure subset of TypeScript, emits
Lean 4 with the `SpecIR` obligations as theorems, discharges them with one
tactic script, and maps Lean's diagnostics back to properties. Where the
script cannot close a goal (induction, most often), a proof can be
supplied beside the spec file: `domain.props.lean` beside
`domain.props.ts`, lemmas first, then a `-- proof: <property>` section of
tactics per property. The proof file is code in the user's repository,
trusted as the spec file beside it is: Eutaxy imports and runs
`domain.props.ts`, so a repository that wants to deceive its own report
already can, and the proof file opens no new door. What Eutaxy
guarantees about a supplied proof is narrower and exact: the statement is
Eutaxy's (each supplied property's statement is emitted as a definition
before any supplied text, so a proof cannot change what it proves);
Lean's kernel accepted the proof; and the proof rests on no axiom beyond
Lean's standard ones (`propext`, `Classical.choice`, `Quot.sound`: `sorry`
is an axiom there), read from Lean's `#print axioms` message at the line
of Eutaxy's own command, with Eutaxy's own `#check` of the theorem showing
exactly the statement and no added hypothesis. That is what keeps a coding
agent from taking the short way to `PROVEN`. It is not a sandbox: Lean is
programmable, and a file written to deceive the checker it runs inside (a
macro, an attribute, an initializer, a `#` command printing a message
shaped like Lean's) stands where a spec file that writes to the report
stands. Such text is refused bluntly, not policed: any `#`, any `@[`, and
the commands that register code or syntax, switch checks off, add axioms
or trusted code, or scope hypotheses (`set_option`, `macro`, `syntax`,
`notation`, `elab`, `attribute`, `initialize`, `simproc`, `run_…`,
`axiom`, `sorry`, `unsafe`, `opaque`, `implemented_by`, `extern`,
`native_decide`, `import`, `section`, `namespace`, `variable`, `include`,
`omit`, `universe` and their kin) refuse the whole file wherever they
stand as a token, in comments and strings too, since telling those apart
would mean lexing Lean. A refused word costs a rename or a reworded
comment, never soundness; a word inside a longer name
(`List.prefix_append`) is that name and passes. The list changes on two
occasions only: a legitimate proof is refused, and the rule narrows; or
the pinned Lean release is bumped and the new release adds a command that
runs code while a file is checked, and the word is added in the same
change. It never grows because someone shows what a hostile file could
do; that is answered above. The verdict is `PROVEN`
and says the proof was supplied. An audit from outside the process that
elaborated the file (a compiled program over the `.olean` that replays
the kernel, as lean4checker does) would hold against a hostile file as
well; it waits for a target that checks proofs it did not write. A second
plain `lean` run that imports the module is not that audit: macros and
initializers travel in the `.olean`. The subset
is specified operationally by the contract corpus
(`corpus/prover-contracts`: functions with known outcomes, provable, given
up on, and outside the subset) and widens one characterised class at a
time. Today the subset is: exported functions, declared or held as an
arrow by a module-level `const` (a `let` or `var` may be rebound, so its
function is outside, and so are its callers), over `number`, `boolean` and
`string` (a union of string literals reads as `string`: the proof covers
every string, more than the type admits), record types (`interface` or
object `type`) declared in the module, nullable types (`T | null`) and
tagged unions of records declared as type aliases (a union needs a tag, a
literal-typed field every member has with a different literal in each),
returning any of those; bodies of `const` bindings, `if` with early
returns and `return`; expressions from `+ - *` on numbers and `+` joining
two strings, comparisons on numbers, `===`/`!==` on any one primitive
type and against `null` (which narrows the name it tests in the branch it
guards, so a field read on a nullable is in the subset only there; where
JavaScript tests truthiness, in a condition or under `!`, a nullable
record or union is a null test, since an object is always truthy, while a
nullable number or string is not, and stays outside),
`&& || !`, the conditional operator, string literals (escapes decoded; a
lone surrogate has no Lean character and is refused), record literals
(a union member's by its tag; a tag chosen by a conditional,
`{ type: c ? "a" : "b", … }`, is read as a conditional between two
literals, the other fields in each as written, which pure fields make
exact), field reads (on a union, a field every
member has: its tag), `Number.isInteger`, and calls to the module's own
functions. A generic function, and a function imported from another file
of the project, is read at each call instead: the compiler resolves the
callee, the call's types instantiate it (from the type the call's value
is expected to have where that decides its type parameters, since the
compiler infers them from the arguments alone, and `err({ type: "locked"
})` would otherwise be an error type of its own rather than a member of
the union the caller declares), its body is read in its own file under
those types, its names are moved clear of the caller's, and it is bound
to the arguments by `let`, which for a pure function called by value is
exactly the call. Its own calls are read the same way, so the helpers of
its file come with it; an outer generic function's type parameters reach
the calls it makes where they stand alone (`id(x)` with `x: T`), not yet
inside compound types (`Ok<T>`), which leave such a call outside. A call
the compiler reports an error on (a name imported with `import type`,
which does not exist when the code runs), a callee without a body (a
declaration file), one its file may rebind, or one reached again while
it is being read (recursion) is outside the subset. A record may be a
member of several unions: `Err<E>` is one of `Result<A, E>` and of
`Result<B, E>`, so decisions sharing an error type share its record, and
an error returned from one result as the other is the same value. Two
members of several unions in common join to no union by themselves; the
declared type where they meet decides. Arrays are in it as lists (`readonly T[]` or `T[]`, Lean's
`List`): literals with a trailing spread (`[i, ...s]`), `length`,
`xs[0] ?? fallback` (the only index, since any other may be past the
end, and not on a list of a nullable type, where `??` replaces a `null`
element too), `slice(1)`, `map` and `flatMap` (the callback may take the index),
`every`, `some` and `reduce`, with callbacks whose body is one
expression. Recursion is in it as structural recursion on a list: a
function whose body first tests a list parameter's length against 0 and
calls itself, in the other branch, only on that list's `slice(1)`; Lean
takes it as a match on the empty list and `head :: tail`, which needs no
termination proof and gives induction its equations; a proof that
unfolds one says it assumes the JavaScript returns, since a long enough
list exhausts its call stack, and a proof over arrays says it assumes
them dense, since JavaScript's array methods skip a sparse array's holes.
Other recursion, mutual recursion included, is outside. Of these the Lean engine takes
everything but the nullable types and the unions, which the SMT engine
takes first; the SMT engine does not take lists. A function using what
an engine does not take is `unsupported` there, as is a caller of one. Ordering strings is refused: JavaScript compares UTF-16 code
units, Lean characters, and the two disagree beyond the basic plane. A function outside the subset, or one calling such a function,
is `UNKNOWN` (`unsupported`) with the construct and the line, and the rest
of the module still goes through; a record type outside it makes the
functions that use it so. Properties are stated over `number`
binders as Lean `Int`, with `when` as hypotheses, and `string` binders as
Lean `String`; records, unions of literals, nullable types and tagged
unions become structures, inductives and `Option` once the SMT engine
takes them; a `bigint` binder (a BigInt argument to a function over
`number` throws in JavaScript), or a regex test in `when`, leaves that
property `unsupported`.

The engine's models of the language are assumptions every `PROVEN`
carries: `number` is the unbounded integers, with no overflow, no fractions
and no `NaN`, so a claim about doubles belongs to the SMT engine, and a
claim that holds over the integers and fails over doubles ends `CONFLICT`
between the two, with the SMT engine's replayed counterexample; `string` is Lean's `String`, a sequence of Unicode
characters, so a lone surrogate, which a JavaScript string can hold, is
outside every string binder's domain; multiplication is emitted but a product of two variables is beyond
the linear arithmetic the script decides, so such a claim is `gave_up`.
Booleans stay `Bool` in terms, as in TypeScript, and become propositions
(`= true`) where a formula needs one; comparisons are `decide`d. `===` on
records is `unsupported`, since it is reference identity in JavaScript,
which the model does not have, and `Object.is` is refused, since it tells
`-0` from `0`; `===` on primitives is the equality to write. A function that is used as a value
anywhere in the module, not only called (assigned to in any form, aliased,
passed on), may not be what its declaration says when called, so it and
its callers are `unsupported` too, as is a record with a `__proto__` field. Every
TypeScript name is emitted under a shape Lean's prelude never uses and
that no other kind of name can take (`f_` functions, `R_` records, `v_`
variables, `t_` theorems), so a function called `decide` or a parameter
called `max` stays what the author meant and no parameter can shadow a
function. The tactic script
is the same for every theorem: booleans to propositions first, while the
`Decidable` instances in the statement still match (unfolding under
`decide` first leaves them stale), Bool binders cased, the module's
definitions unfolded, each conditional split, then `omega` on what remains.
A proof that does not close is `gave_up`, since Lean does not say whether
the claim is false or the script weak; the `TESTED` rung is what refutes.
`total` is `PROVEN` when Lean accepts the definition, which it does only
for functions that terminate. Translation validation is part of the
engine's tests: for every corpus function, the Lean definition must compute
what the TypeScript computes on inputs drawn from its parameter types,
checked by Lean's kernel (`example … := by decide`).

Lean runs over a process boundary. The engine is pinned to one release
(`leanToolchain`), found through `elan`, Lean's toolchain manager, only
when it already has that release, or through a bare `lean` of exactly that
version; nothing is downloaded during a check, and a missing toolchain is
`unavailable` with the command that installs it. One Lean run checks a
whole module; a failed theorem does not hide another, since diagnostics are
mapped to theorems by line, and an error outside every theorem means the
emitted definitions did not compile, an engine gap reported as
`unsupported`, never as a verdict. Timeouts are `gave_up`. The Lean kernel,
not Eutaxy, checks the proof.

**First-party engine (`prover-smt`).** The same subset emitted as SMT-LIB 2
and decided by Z3, pinned to one release and run over a process boundary
like Lean. It models what the Lean engine assumes away: `number` is the
IEEE double (the floating-point theory, so `NaN`, the infinities, `-0` and
the integers past 2^53 are in every binder's domain), `string` is a
sequence of 16-bit code units (so `length` and ordering are JavaScript's),
records and tagged unions are algebraic datatypes: a record one
constructor, a union one constructor per member holding that member's
record, so a record that is a member of several unions keeps one sort, is
wrapped in a union's constructor where that union is expected, and is
unwrapped where a test of the tag narrows the union to it (an error moving
from `Result<A, E>` to `Result<B, E>` is unwrapped from one and wrapped
in the other; a binder of a union type is the one declared union its
members match field for field and type for type, and a binder two unions
match alike is outside rather than guessed), a nullable type an option datatype with `null` its `none`, and a
name narrowed by a null check is bound to the option's value in the branch
the check guards. Budgets are the solver's resource limit, never wall-clock
time, so the same input gives the same outcome on every machine, and
exhausting it is `gave_up`. `unsat` is `PROVEN` with the engine's models
as assumptions. `sat` gives a model, which is a candidate counterexample,
not a verdict: Eutaxy runs the TypeScript function on it first, and only a
claim that fails on the real function is `REFUTED` (the input reported,
shrunk as `TESTED` shrinks); a model the function does not confirm is a
modelling gap, `UNKNOWN` (`unsupported`) with the input. The solver's
proof is not checked by a kernel; what makes the engine trustworthy is
that refutations are replayed, proofs name their models, and the Lean
engine proves the same contract corpus, so a disagreement is `CONFLICT`.
Nonlinear arithmetic over doubles, recursion and induction are where the
solver gives up and Lean takes over; `total` is Lean's alone, since a
solver does not decide termination. The engine is pinned to one Z3
release (`z3Version`), found on the PATH and required to report that
version; nothing is downloaded during a check.

**A further engine** would be a sibling package behind `Prover`, selected
by the CLI like the two first-party ones; none is planned, since the two
first-party engines cover what the roadmap's targets need, and two engines
are what `CONFLICT` is for.

```ts
export interface Prover {
  readonly name: string;
  /** Whether the engine can run here, or why not. */
  available(): Promise<{ readonly version: string } | { readonly unavailable: string }>;
  prove(input: ProveInput): Promise<ModuleProofs>;
}
```

Engine rules:
- Talk to engines over a process boundary (spawn, files, parsed output),
  never a library import, so Lean and Dafny stay out of Eutaxy's install.
- Users write specs once; each engine generates its own syntax
  into a temporary copy and maps results back to source locations.
- Record engine name and version with every `PROVEN`, and cache results
  keyed by source hash, spec hash and engine version so CI does not
  flip-flop.
- Treat timeouts as `UNKNOWN`, never as failures; prefer Lean backends where
  determinism matters.
- Each engine has a contract corpus of functions with known verdicts
  (provable, refutable, out of scope), including spec-translation cases, run
  in CI against the pinned engine version.
- Aggregation across engines: one proves and another gives up gives `PROVEN`
  with the proving engine named; one proves and another refutes gives
  `CONFLICT`.

| Engine                      | Best for                                                      | Backend        | Main caveat                                           |
| --------------------------- | ------------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| `prover-lean` (first-party) | Push-button proofs of the pure core, on Eutaxy's own schedule | Lean 4         | Subset starts narrow and widens deliberately          |
| `prover-smt` (first-party)  | Doubles, strings and records; symbolic counterexamples        | Z3 (SMT-LIB 2) | No kernel-checked proof; refutations replayed instead |

## Packaging, distribution and developer experience

- One published package, `eutaxy`, with subpath exports `.` and
  `./cloudflare` and a `bin` for the CLI. Internal packages are bundled into
  it at build time (`pnpm build`, tsdown from the repository root, ESM with
  bundled declarations); they are declared as its dev dependencies, so the
  published manifest has no runtime dependencies. `publishConfig` swaps the
  workspace entry points (TypeScript sources) for `dist/` on publish, and a
  test packs the tarball and checks it is self-contained. Releases are
  published by a GitHub Actions workflow on a version tag through npm
  trusted publishing (OIDC) with provenance: the workflow packs with pnpm,
  so `publishConfig` applies, and publishes the tarball with npm.
- Peer dependencies only for what users already have: Vitest and the
  Cloudflare Vitest plugin, pinned to tested major versions because that
  integration's API has moved more than once.
- Provers opt-in: `eutaxy prover install lean` (and `… smt`, roadmap)
  fetches a pinned, checksum-verified toolchain. Projects list engines in
  `eutaxy.config.ts`; a listed engine that is not installed yields
  `UNKNOWN`. Never `optionalDependencies`, never a silent download during a
  check.
- Split into separate packages later only for a reason, most likely a
  prover engine. Released in lockstep with exact version pins.

| Command                        | Does                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `eutaxy check <spec>`          | Run a scenario; print the verdict and the shrunk trace, write a regression test |
| `eutaxy report [dir]`          | Run the spec ladder on every spec file under a directory, without a scenario    |
| `eutaxy prover install <name>` | Download a pinned prover toolchain                                              |

`report` covers the pure core and needs only Node: it imports each module
and its spec file, runs `TESTED` and, with `--prover`, `PROVEN`, and prints
the verdicts by module. Scenario verdicts stay with `check`, since a
scenario runs inside workerd under a budget and running all of them is the
job of the project's test suite, which the regression tests already join.
A spec file run by itself needs no separate command: `report` on its
directory is that.

Every command takes `--json`, printing one object in a versioned schema
(`schemaVersion` 1, canonical JSON) for CI and coding agents; within a
version, new verdict kinds and optional fields may appear, so a consumer
switches on `kind` with a default, and a removed or re-typed field bumps the
version. The exported TypeScript unions keyed by `kind` (`SpecType`, the
verdict types) follow the same rule: a release may add a kind (a type the
reader reads, a verdict), so code switching over one keeps a default
branch; removing or reshaping a kind is a breaking change. A failing check
writes a Vitest file that replays the shrunk schedule on the restricted
scenario inside workerd and expects the invariants to hold, so it fails
while the bug exists and passes once fixed; `expectHolds` and `check` from
`eutaxy/cloudflare` run the same check from a user's test suite.
The emitter in `report` knows no platform: the Cloudflare entry point
supplies the imports and the platform expression.

Default exploration budget is time-based (a few seconds) with the bounds
actually reached reported in the verdict, rather than a fixed count. A
time budget makes how many runs fit depend on the machine, so a seed alone
does not fix the verdict: CI and tests that assert one replace the
scenario's budget with a generous one (`budgetMs` in the explore options,
`--budget-ms` on the command line) and cap the runs (`maxRuns`,
`--max-runs`), so the run cap ends exploration.

## Trust anchors and self-verification

Eutaxy checks as much of itself as it can with its own tools, but its final
word comes from anchors it does not control.
- **Planted-bug corpus** (`corpus/planted-bugs`): Workers with known bugs,
  each with the verdict Eutaxy must reach. CI fails if any is missed. This
  guards against the checker that cannot fail.
- **Differential corpus** (`corpus/differential`): fault-free scenarios run
  twice inside workerd, once through Eutaxy's proxies and once with the
  handler called directly on the raw bindings; the per-attempt decisions
  and the final D1 tables and R2 objects must agree. Any divergence is a bug in Eutaxy's
  proxies or platform model. The raw side shares Eutaxy's reading of the
  queue semantics but none of the proxy code. The proxied side and the
  comparison are platform-neutral and live in `engine`; each platform
  writes only its raw side and what an attempt's record holds.
- **Lean kernel**: proofs that pass through a prover adapter are checked by
  Lean, not by Eutaxy, so they are independent of Eutaxy's own code.

Self-verification targets, by cost of a bug:

| Component             | Spec                                                                                                            | Cost of a bug                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Exhaustive enumerator | Every schedule within bounds appears exactly once; count equals a closed-form formula; same seed, same schedule | False `BOUNDED` on every check     |
| Invariant checkers    | Match a naive reference implementation on the same effect log                                                   | False `BOUNDED` for that invariant |
| Verdict logic         | `VIOLATED` only after a successful replay                                                                       | False alarms                       |
| Shrinker              | Output still violates and is no longer than input                                                               | Unhelpful traces only              |

The invariant checkers are held to their references by Eutaxy's own spec
file beside them in `core`: each checker gets a form over plain data
(drawn effects in small domains, so targets, ops and keys collide as in
real logs; a selector anchored on a drawn effect, so it selects
something), and each property states that the real checker, run on the
log those effects make, reports what a naive reference written in the
spec file reports. `eutaxy report packages/core/src` runs them at
`TESTED`, and a test plants bugs in a copy of the core and requires each
refuted, so the self-check is shown to fail when a checker is wrong.

Not self-verifiable: binding proxies, globals patching and the workerd/Vitest
glue (covered by differential testing), and the spec reader (a common-mode
failure, covered by a corpus of modules with known `SpecIR`; what it reads
is what the TypeScript compiler resolved).

## Risks

| Risk                                                                            | Mitigation                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Platform model is wrong or goes stale (Cloudflare documents semantics in prose) | Differential corpus against workerd; assumptions listed in every verdict                  |
| False `BOUNDED` from module-level state leaking between runs                    | Two-order detection, downgrade on mismatch                                                |
| State explosion once Durable Objects and multiple messages arrive               | Partial-order reduction (independent keys commute); explicit bounds in every verdict      |
| False alarms from impossible Durable Object interleavings                       | Real objects, so the runtime's own gates apply; every violation replayed before reporting |
| Prover engines are young and churn                                              | Optional adapters, pinned versions, contract corpus, graceful `UNKNOWN`                   |
| Numeric semantics differ between engines and JavaScript                         | Engine-level number model recorded as an assumption; `CONFLICT` when engines disagree     |
| Cloudflare Vitest integration changes its API again                             | Peer-dep pinned to a tested major; the three assumptions above are tested in CI           |

## Open questions

- Durable Objects beyond the stub boundary: recording the object's own
  binding calls; and a corpus entry in which an alarm interleaves with a
  call into the same object (Cloudflare allows it, the engine treats an
  alarm as an event like any other, and no scenario exercises it yet).
- Whether the two engines' string models (code units in SMT, characters in
  Lean) need a corpus entry for every string claim, or the `CONFLICT` rule
  on the shared corpus is enough.
