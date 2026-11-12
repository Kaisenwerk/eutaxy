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
differential scenarios, phase gates, prover contracts; never published),
`examples/` and `docs/`.
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
caller has `retries: 0`. An uncaught exception, or a handler that resolves
to anything but a `Response`, is a 500 response.
`httpResponse(path, { ok })` selects responses for invariants such as "one
2xx per request", and `atLeastOncePerMessage` accepts every drive.

`rpc(calls, caller)` drives a `WorkerEntrypoint`: each call (a method and its
JSON arguments) is an event; each attempt constructs the entrypoint anew with
a fresh `ExecutionContext`, as the runtime does, and calls the method. The
return value is the response effect (`Rpc:<method>`, or
`Rpc:<Entrypoint>.<method>` for a named export, op `response`, result
`{ ok: true, value }`); an exception is the error the caller sees
(`{ ok: false, error }`, its name and message, as RPC propagates it). The
entrypoint is the Worker's default export (the class passed as the handler)
or the named export the drive's `entrypoint` gives. Cloudflare does not
retry an RPC call, so the caller's policy decides resends as for HTTP,
without `retryOn`: a call that threw or got no answer is resent up to
`retries` times (default 0: a calling Worker resends only when written to).
A result that is not plain data (a stub, a function, a stream) makes the run
`UNSUPPORTED`. `rpcResponse(method, { ok })` selects the answers.

`cron(expression, { ticks, retries })` drives the `scheduled()` handler: the
expression's first `ticks` matches from the virtual epoch on (Cloudflare's
dialect, in UTC, weekdays 1 = Sunday to 7 = Saturday; `L`, `W` and `#` are
refused) are events delivered at their virtual time, so the handler sees
`scheduledTime` as the tick's time, `cron` as the expression, and the clock
at that minute. Cloudflare documents `noRetry()` but no retry count, so the
drive declares how many times a tick whose handler failed is re-run (as the
same tick, default 0); `noRetry()` is a decision effect (`Cron:<expression>`,
op `no_retry`) after which no re-run follows, and spent re-runs record
`gave_up`.

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

**Service bindings are scripted callees.** A Worker reached through a
service binding (`env.BINDING`, by RPC method or by `fetch()`) is declared
with `service(binding, { methods, fetch })`: each method's reply, a value
returned or an error thrown to the caller as RPC propagates it (name and
message), and the replies to `fetch()`, matched by method and path as an
external's are. The real binding is never called. Each call is one effect,
`Service:<binding>`, with the faults of a Durable Object stub call:
`crash_before` and `error` mean the call never reached the callee,
`ambiguous` that it acted and the answer was lost, `crash_after` that the
caller died after it; Cloudflare itself retries none of them. A scripted
error names a built-in class and is thrown as that class, as RPC keeps the
type. A binding without its setup step, a method the script lacks, an
unmatched `fetch()`, a redirect reply the runtime would follow (script the
final reply, or fetch with `redirect: "manual"`), promise pipelining and
`connect()` make the run `UNSUPPORTED`, and every verdict states that
callees were scripted. A callee the scenario runs for real is the next
paragraph; the scripted boundary stays for the Workers it does not.

**Workers calling each other, for real (v0.14).** A system split by
business context is several Workers, each with its own bindings, calling
one another through service bindings; a bug that crosses two of them (a
reservation the callee committed and the caller then lost, a retry the
callee did not make idempotent) hides from a check of either Worker alone
with the other scripted. So a scenario can name a callee as it names its
own Worker: the setup step `callee(binding, { entry, config, entrypoint? })`
replaces `service(binding, …)` for that binding with the callee's module
and wrangler config, relative to the scenario, and the Worker's name from
that config (its `name`) qualifies everything of the callee's. The callee's
real code then runs in the same simulation as the caller's, in the same
isolate, as Cloudflare routes a service-binding call on the same thread
(developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
- _The call._ A call through the binding (an RPC method, or `fetch()`) is
  one effect, `Service:<binding>`, as a scripted call is, with the faults
  a call has in the network: `crash_before` (it never reached the
  callee), `ambiguous` (the callee acted, the answer was lost) and
  `crash_after` (the caller died after it); `error` is gone, since what
  the callee throws is now real. The effect hosts the callee's invocation,
  as a Durable Object stub call hosts the object's effects and a WebSocket
  `send` the handler's: inside it the callee's code runs as a fresh
  invocation of its own (`<caller invocation>/<binding>.<method>`, `#<n>`
  for the n-th call of that method from one caller invocation), so its
  effects are recorded under it, interleave with other invocations' as
  turns, and take faults by their position within it, while the caller is
  parked at the call. The engine runs it through `hostInvocation`: the
  hosted code is known by an async context of its own, so its effects and
  timers are its own while the caller's code, which may go on meanwhile
  (two calls awaited together), stays the caller's; the hosting effect
  waits on the hosted code without counting as I/O of its own; and the
  hosted code's timers are virtual (inside an effect's perform the
  library's are real). An RPC call constructs the
  callee's `WorkerEntrypoint` anew with a fresh `ExecutionContext` (whose
  `props` are what the caller's service binding carries in its wrangler
  config, so the callee reads who called as in production) and the
  callee's `env`, calls the method and answers with its return value,
  plain data (a stub, a function or a stream in it makes the run
  `UNSUPPORTED`, as for the RPC drive); what the method throws reaches the
  caller as RPC propagates it, a new error with its name, message and
  serializable own properties, a built-in class as itself
  (developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/).
  A `fetch()` through the binding calls the callee's default `fetch`
  handler (a handler object's, or an entrypoint class's method) with the
  request, its `env` and `ctx`, and the response crosses as it is; a
  handler that throws rejects the caller's `fetch()` with the error, as
  workerd does across a real binding (checked, 2026-11-04). The callee's
  `waitUntil` work runs after its answer and before the answer crosses to
  the caller (a `background` point of the callee's invocation, admitting
  `cut_off`): one of the orders the runtime allows, the only one explored. A crash inside the callee (a fault on one of its effects)
  ends its invocation, and the caller sees an error thrown from the call,
  as it does when the Worker behind a binding fails; Cloudflare retries
  nothing, so the caller's own code decides what follows. These are the
  model's assumptions and every verdict states them.
- _The callee's bindings._ The callee's wrangler config names its bindings;
  Eutaxy proxies them with the same binding records as the caller's and
  tells the two Workers' apart by qualifying the callee's with the
  Worker's name: its `DB` is `orders/DB` in effect targets
  (`D1:orders/DB`), in setup steps (`d1Schema("orders/DB", …)`), in state
  queries and in snapshots; the caller's keep their bare names. The
  callee's `env` is a view that maps its own names onto those entries, so
  its code runs unchanged. Two bindings that name one resource (the same
  `database_id`, bucket or KV namespace; a Durable Object class the caller
  binds from the callee's script with `script_name`, or the callee from
  the caller's) are one resource with one snapshot, under the caller's
  name, and the callee's name is an alias of it: the platform's `aliases`
  option (`{ "orders/STOCK": "STOCK" }`), which `eutaxy check` derives from
  the two configs, makes the alias read as the caller's binding in `env`,
  so the callee's effects on it carry the caller's name; a setup step on an
  alias is refused (one resource is set up once). A callee's Workflow runs
  the callee's class with the callee's env, found among the callee's
  exports. A service binding of the callee's own is scripted
  (`service("orders/PARTNER", …)`) or a further callee
  (`callee("orders/PARTNER", …)`), whose invocation nests
  (`…/ORDERS.reserve/orders/PARTNER.quote`); the depth is not bounded.
  The further callee may be the scenario's own Worker, called back by the
  Worker it called: a `callee()` step whose config names the Worker the
  scenario drives (the command tells by the name; a test says
  `self: true`) runs that Worker's module with the scenario's env as it
  is, under its own names, so what the call back reads and writes is what
  the scenario's events read and write, and an event it sends wakes a
  Workflow of the scenario's that waits for it. A Worker called from
  inside a Durable Object (an object's own binding, see Durable Objects)
  runs in that object's I/O context, where a promise settled from outside
  would resume it in the wrong one: its effects wait for their turn on
  the object's poller, as the object's own do.
- _Running it under the Vitest plugin._ The plugin runs one `main` module in
  the test's isolate, where the engine's patches apply (its auxiliary
  Workers run elsewhere, unpatched, so they are not what this is built
  on). `eutaxy check` therefore generates, beside its test and config,
  one main module that imports both Workers' modules and re-exports the
  caller's exports as they are and the callee's Durable Object classes
  under their qualified names, and a Vitest config whose `miniflare`
  options add the callee's resources (D1 databases, R2 buckets, Durable
  Object namespaces pointing at those classes, queues) under their
  qualified names, read from the callee's wrangler config; the caller's
  config stays the plugin's `wrangler.configPath`. A scenario run from a
  user's own test, without the command, gives the platform the callee's
  name and exports (`callees: { ORDERS: { name, exports } }`) and an `env`
  that holds the qualified entries, as it gives the caller's today; the
  caller's wrangler config may declare them under their qualified names
  (`"binding": "orders/DB"`), which wrangler, the plugin and workerd accept.
  The command learns the callees by importing the scenario module in Node
  (only when its source mentions `callee(`), reads each callee's wrangler
  config as JSON or JSONC (a TOML config is refused), and names in its
  output what it did not carry into the isolate (a Durable Object class of
  a third Worker, bindings Eutaxy does not model). Service bindings, the
  caller's to its callees and the callees' own, are answered by a function
  of the generated config, so the value exists as a Fetcher and is never
  called (the Worker the caller's config names is not in the isolate, and a
  worker named through miniflare options must be one the plugin knows). workerd constructs a callee's
  Durable Object classes with the main Worker's env, so the generated main
  module exports each as a subclass handing its parent the callee's view of
  that env (`calleeEnv`), under which `this.env.DB` is the callee's. A
  regression test written for such a scenario says at its top which
  qualified bindings its isolate needs, since it runs under the user's own
  config.
- _Not modelled._ `connect()`, promise pipelining, RPC stubs passed by
  reference, streams across the call, and a callee reached by anything but
  a service binding (a queue the callee consumes is the callee's own drive,
  and a scenario drives one Worker). The differential corpus keeps to the
  binding proxies: both Workers' code is real on either side.

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

Which of these an effect admits follows its kind, and `core` writes each
kind's ladder once (`writeFaults`, `readFaults`, `decisionFaults`) for
every proxy to name: a write, a call into another system or an outbound
request admits the first four; a read admits all but the ambiguous outcome,
since nothing is lost when its answer is; a decision a platform records on
the invocation's behalf (an acknowledgement, a message's delete) admits only
the crashes either side of it. A point with a meaning of its own, the
response point, a Workflow step, the background point, lists exactly the
faults that mean something there.

Redelivery follows one rule, written once in `core` (`redelivery`): an
event that was not handled is delivered again while the platform's own
limit on redeliveries (Queues' `max_retries`, the caller's `retries`, SQS's
`maxReceiveCount` less the first delivery, an alarm's six retries) and the
scenario's `maxRedeliveries` both leave room. The platforms and the
differential runner's raw sides call the same function, so the raw side
shares the reading of the limit and none of the proxy code.

**Platform semantics to encode, with a documentation source for each:**
- D1: `batch()` is all-or-nothing; separate `run()`/`first()`/`all()` calls
  are each one effect and can be cut between statements; prepared statements
  are not effects until executed.
- Queues: at-least-once delivery; per-message `ack()`/`retry()`, batch
  `ackAll()`/`retryAll()`; a crash mid-batch redelivers every unacked
  message; `max_retries` and dead-letter queues.
- Inbound requests: one invocation per attempt; an uncaught exception in
  `fetch()`, or a result that is not a `Response`, is answered with a 500
  (Workers runtime); resends follow the
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
- Inbound RPC: one invocation per call attempt; the entrypoint, the default
  export or a named one, is constructed for each call (Workers RPC; service
  bindings, RPC); an exception propagates to the caller as a new error with
  its name and message (RPC error handling); Cloudflare does not retry a
  call, so the caller's declared policy decides resends as for inbound
  requests, and the policy's deadline and delays mean the same.
- Service bindings: each RPC call or `fetch()` through a binding is one
  effect answered from the scenario's script, with a Durable Object stub
  call's fault meanings; the call runs on the same thread and Cloudflare
  retries nothing (service bindings).
- Cron Triggers: one invocation of `scheduled()` per tick attempt, with
  `scheduledTime` the tick's time and `cron` the expression (Scheduled
  handler; Cron Triggers); `noRetry()` is documented, a retry count is
  not, so the drive declares the re-runs of a failed tick.
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
  snapshotted after it: the key-value entries as rows `{ key, value }`
  under the object's name, and, for a SQLite-backed object (the backend
  Cloudflare recommends and the Agents SDK requires), every user table
  with its rows under `<object>/<table>` (`durableObjectTable` selects
  one; the runtime's own `sqlite_*` and `_cf_*` tables are left out, the
  key-value API's hidden table among them). The setup seeds SQL storage
  too (`sql`: the `CREATE TABLE` statements and rows per table, run after
  the clear, which drops SQL and key-value data alike), so a scenario
  states an object's starting tables as it states a D1 schema (a row with
  no columns inserts the table's defaults; an object's or a table's name
  may not hold `/`). An object the run never reached shows the tables the
  reset read back after seeding, as SQLite holds them, defaults and
  generated values included. A class built on the Agents SDK runs as
  written on that storage: its state and schedules in the SDK's own
  tables (`cf_agents_*`, user tables to the snapshot), its schedules over
  the object's one alarm, which fires in virtual time, and its router
  walking the Worker's bindings; the Cloudflare Vitest plugin's own
  bindings (`__VITEST_POOL_WORKERS_*`) are hidden from the proxied `env`,
  since they are the test environment's, not the Worker's, and a Worker
  that enumerates `env` must not meet them. SQL calls
  (`ctx.storage.sql.exec`, `transactionSync`, the synchronous
  `ctx.storage.kv`) are held by the input gate like key-value calls and
  are not turns; nothing is recorded for them, as nothing is for key-value
  calls. Snapshot rows are sorted by their canonical JSON, since a table
  has no order of its own. Alarms are
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
  would resume in the object's I/O context. A turn released to such code
  is on its way until the object's poller has ticked: the scheduler does
  not take the run for at rest before then, or it would decide with that
  code's next effect among its options on a fast tick and missing on a
  slow one. A call whose code is idle inside an object with nothing
  parked of its own may be awaiting what another call of the same object
  started (a load the object dedupes): while such code is all that is in
  flight and an effect of that object is parked, the run is at rest, for
  that effect to get its turn. A call counts as waiting on its own parked
  effects only once its code runs in the object: one whose constructor
  left an effect parked is still on its way in until its method starts.
  A delivery whose invocation crashed is the platform's to end
  (evicting the object a crash reset takes real time), and is waited for
  within the budget rather than taken for stuck. While an object holds its
  input gate with `blockConcurrencyWhile` nothing else can enter it, and
  even its timers wait at the gate, so its effects run at once then
  (`EffectOptions.mayPark`). Work an object starts and does not await (a
  promise left running, as an agent runs a job after accepting it; a timer
  it set; `ctx.waitUntil`, which in an object only keeps it from being
  evicted) goes on after its answer, as the runtime keeps the object alive
  while anything of its is pending (Cloudflare, Lifecycle of a Durable
  Object; Durable Object State, `waitUntil`): the model runs it as an
  invocation of the object's own, `DO:<binding>/<object>/after`, whose
  effects are turns of their own and take faults by their position in it,
  until nothing of it can move, as an object with nothing pending goes
  idle (work woken later revives it), or a crash resets the object, which
  ends it with the instance; the object's next instance's work is a new
  invocation (`/after#2`). Work that never settles (a heartbeat: an
  interval, a timer that re-arms itself), which the runtime would run until
  the object is evicted, is waited for up to 100 timer firings without
  settling (`afterWorkTimerLimit`, counted from the last time the work
  settled, whichever wait fired them); past that the run is `UNSUPPORTED`
  and names the object. In a sequential run that work runs to rest
  before the next event, one of the orders the runtime allows; a
  concurrent run explores the others, the second call entering the object
  while the first's work awaits its model among them. The runtime carries
  no async context into an object's code, so the platform enters it
  itself: before a call it wraps the method about to run (on the class,
  looked up per instance), and it runs an alarm or WebSocket handler the
  same way (`RunHooks.hostedCode`, `EffectOptions.host`). The code so
  entered carries the effect it is the call of (the object's input gate
  delivers calls in arrival order, so the oldest of the object's effects
  whose call has not started is it), which makes an effect the object
  makes during a call that call's, two calls inside the object at once
  told apart, and the work after an answer that of the call that left it.
  Work after an answer that holds the input gate with
  `blockConcurrencyWhile` runs its effects at once, as a call's does.
  Timers the object's code sets are the object's,
  not the caller's, and in workerd are run by a poller armed inside the
  object, as are its waits for a turn after its answer: a real timer the
  object's code armed after its request completed would keep the object
  referenced. An object that awaits a timer of its own before it answers
  is woken by it: while everything in flight is a call whose object's code
  is running and idle (it has entered the object and not returned; no
  effect of it performing or waiting, nothing hosted in it, no real work
  tracked) and
  one such object has a timer pending, the run fires those objects'
  timers, after a tick for work it cannot see (a call crossing into the
  object, storage I/O); the caller's own timers stay the caller's and do
  not fire while its call is in flight, and once the object's code has
  returned its call is in flight until the answer has crossed, so a timer
  it set and did not await fires after the answer. Work the object's
  code has outstanding when the call answers (an effect it issued and did
  not await, performing or waiting for its turn; a timer; real work such as
  a Web Crypto digest) is the object's from then on: the run waits for it,
  the caller's crash does not end it, an effect of it that opens after the
  answer is recorded as the object's, and a fault in it resets the object,
  not the caller. A crash injected into an effect the object makes during a
  call crashes the call and resets the object; the run sees a crash on its
  own ticks (a wait on a crashed invocation ends with its `CrashSignal`),
  since the reset tears down the object's task, with whatever that task
  had settled. An object's own bindings are the scenario's. The runtime
  hands an object the Worker's real `env`, where a service binding is
  whatever the isolate holds under that name, a database or a bucket
  is the real one, whose calls nothing would record or fault, and a
  Workflow binding is the local engine, which would run the class on the
  real clock. So the model puts the instance's `env` behind a view under
  which every binding but another object's namespace is what the Worker
  sees under that name (for a callee's object, under the callee's
  qualified name): a service binding, a D1 database, an R2 bucket and a
  Workflow binding are the Worker's own proxies for them, resolved when
  first used (reading one off `env`, or preparing a statement, does
  nothing), and a binding of a kind the model does not cover is the
  Worker's stand-in for it, whose every call is refused and makes the
  run `UNSUPPORTED`, never passed on. A call the object makes through one is an
  effect of the invocation its code is running as (the call it is
  serving, the call entering it while its constructor runs, or its own
  work after the answer), with that binding's faults: a service's
  answered from the `service()` script or by the `callee()` hosted
  inside it, a statement (`run`, `all`, `first`, `raw`, a `batch`, an
  `exec`) or a bucket operation performed on the real store, a Workflow
  instance created, found or asked for its status in the model, where
  it runs the scenario's class as an event of the run (a call on the
  instance the binding gave is the object's call as well). A crash
  fault on it resets the object as on any effect the object makes. That
  is where a write outside the object and the object's own record of it
  come apart: the store has the write, the object's storage does not
  say so, and whatever enters the object next decides again.
  The call leaves the object only once what the object wrote before it
  is durable: the storage's `sync()` is awaited inside the effect, before
  the call is performed, as the runtime's output gate holds an outgoing
  message until the writes before it are confirmed (the gate is handed
  to the stub in a slot the stub empties as it takes it: a crash fault's
  `abort()` ends the object's code without unwinding, and a gate left
  behind would be the next call's to wait on, another object's storage).
  A fault that resets
  the object after the call therefore finds a claim the object recorded
  before calling, and one that keeps the call from leaving does not make
  the writes durable. Storage operations are not turns (the input
  gate holds them, so this is the runtime's behaviour). A callback
  behind the input gate that fails breaks the gate, and the runtime
  resets the object: the model takes the instance for gone from there,
  with its work and its poller, as after a crash inside it, so the call
  that was entering fails, the next event constructs the object again,
  and when none comes it is woken before the snapshot. An object whose
  construction fails in more wakes than the run has faults fails by
  itself: it is not woken again, the snapshot leaves out an object it
  cannot enter, and the run is `UNSUPPORTED` with the reason. A
  constructor runs before the method a call names, on the first call of
  a run as in a wake, and the runtime carries no context of the call
  into it. Two things put it inside the model all the same. A Durable
  Object class among the modules the platform is given (the Worker's
  exports, the callees') is given a base of the platform's between
  itself and the runtime's `DurableObject`, which hands its constructor
  the view over `env`: `this.env` is the scenario's from the
  constructor's first line, so a call it makes through a service binding
  is answered and recorded as any of the object's is. And what the
  constructor does behind its input gate (`blockConcurrencyWhile`,
  wrapped on the state's prototype) runs as the object's code while the
  call is on its way in (`RunHooks.hostEntering`): its timers are
  virtual and the object's, so one it awaits is fired for it as for an
  object sleeping before it answers, and its effects are the entering
  call's; the call's method starts once the gate is released, as in the
  runtime. The reset constructs each seeded object too, outside any run:
  there a method of a scripted service binding is answered from the
  script, unrecorded, so that a constructor that loads from one comes
  up, and anything else through a service binding, and any call on a
  Workflow binding, is refused, never passed to the isolate's own; a
  database or a bucket is the real one
  there, so a constructor that reads one needs that store's setup step
  before the object's, and what a constructor writes to one is written
  once more by the reset, before the run. Still outside: a class the platform is
  not given (its `env` is put behind the view once its constructor has
  returned), the `env` parameter a constructor keeps for itself where
  `this.env` would do, and a timer the constructor's own body sets
  outside the gate and does not await, which is the calling
  invocation's (in a wake, where that invocation ends at once, the run
  is `UNSUPPORTED`); an
  object reached
  only through another object's binding makes the run `UNSUPPORTED`, as do
  `jurisdiction()` namespaces (and a unique id asked for one) and a
  namespace the scenario does not reset (no `durableObject` setup).
  `newUniqueId()` is drawn from the run's random stream, as a named id
  whose name is the draw, so it repeats on replay, the reset finds its
  object, and the draw counts as a read of randomness (which id an
  invocation gets depends on the order of turns); the Worker sees that
  name on `id.name`, where the runtime has none. An object no call
  reached is snapshotted from its seed without being constructed. Reset
  constructs each object outside the simulation, with the network blocked:
  a constructor that makes a request fails the reset. An object a crash
  reset and nothing entered since (a crash inside a call nothing follows,
  or on a watchdog alarm's last retry) is woken inside the run when
  nothing else is left to move: one effect of an invocation of its own,
  `wake:<binding>:<object>:<n>` (`DO:<binding>` `wake`, no faults of its
  own), constructs the instance as the object's next event would, its
  constructor's effects hosted and its clock and requests the run's, so
  the snapshot reads what a next reader would find and not an object
  built after the run with the real ones (the platform's closing events,
  `Platform.closingEvents`, asked until there are none). A timer the
  woken constructor leaves running is not followed, since the runtime
  carries no context of the wake into the constructor, and makes the run
  `UNSUPPORTED` (`RunHooks.timersPending`). An instance the
  object dropped by itself, which the model did not see go, is still
  reported: the snapshot would construct it outside the simulation, and
  the run is `UNSUPPORTED` rather than guessed. A call still in flight when its caller's invocation crashes
  elsewhere (a fault in a Workflow step's retry while the late attempt's
  call runs; the object is a separate isolate, so the runtime's call goes
  on) is handed to the object: what its code still does is the object's
  own work after an answer, and the answer goes to nobody; the call the
  crash happened inside resets the object, as before. A stub property can
  be called (a method) or awaited (an RPC getter); either is one effect.
  A result that is not plain data (an RPC capability) makes the run
  `UNSUPPORTED`, since calls on it would bypass the proxy.
- WebSocket connections (v0.13): the `websocket` drive opens each
  connection with an upgrade request through the Worker's `fetch` (one
  event, as a client would; the Worker hands it to an object, whose
  `fetch` answers 101, and Eutaxy keeps the client end) and sends its
  messages in order (one event each). A message is delivered inside the
  object by calling its `webSocketMessage` handler (the Hibernation API,
  which the Agents SDK uses; the standard API is not modelled) on that
  connection's server end, as an alarm is delivered by calling `alarm()`,
  with an alarm's faults: `crash_before` (the object crashed before
  handling it), `crash_after` (handled, then crashed) and `error`. A
  crash drops the instance, which is rebuilt at once as an effect of its
  own (`rebuild`, invocation `<message>/rebuild`, hosting the
  constructor's effects: no retry follows a message, and an object rebuilt
  only for the snapshot would have run its constructor outside the run),
  and the runtime keeps
  the connection, as it does across hibernation ("removed from memory ... while keeping its
  WebSockets connected", developers.cloudflare.com/durable-objects/api/state/):
  the next instance sees it as a new `WebSocket` with the attachment and
  tags the object gave it, so before each message the connection's server
  end is found again in the live object: by identity, else by its tags,
  else by tags and attachment (tags are fixed at accept; the attachment
  the object may rewrite); an object that gives its sockets neither cannot
  have its connections told apart after a crash, and the run is
  `UNSUPPORTED`. The
  server end is the one socket the object holds during the open that no
  connection does, so opens run one at a time, in order, while messages of
  different connections interleave as concurrency allows (each waits for
  its connection to be open and for the message before it on that
  connection). A connection the object closed (its handler called
  `close`) takes no more messages: each is recorded as not delivered
  (`send`, result `delivered: false`). What the object sends back arrives
  on the client end; the frames are kept per connection in arrival order
  and recorded at the end of the run (`WebSocket:<connection>`, op
  `message`, under the platform's own invocation), since when a frame
  crosses the pair is the event loop's doing, not the schedule's, and a
  trace must repeat; `webSocketReceived` selects them. The scenario's own
  messages are `WebSocket:<connection>` op `send`; a close the object made
  during the run is recorded too (op `close`, with its code and reason).
  A close the object makes before answering the upgrade is the same: the
  connection is open and closed at once, its messages not delivered. The
  connections still open are torn down after the snapshot, outside the
  run: what the objects' `webSocketClose` handlers do then is not
  modelled; they run after the sandbox is gone, so a request one makes
  while the teardown waits for the sockets to go is blocked and makes the
  run `UNSUPPORTED`, but work a handler defers past a timer outlives the
  teardown and is not caught (a known limit, as is a client's close as a
  scenario event, which the run does not have yet). An object on
  `setWebSocketAutoResponse` makes the run `UNSUPPORTED`: the runtime
  answers those messages without waking the object, and Eutaxy, which
  hands every message to the handler, would not. A Worker that dies after
  the object accepted (a fault on the stub call of the open) leaves a
  client end nobody holds: it is dropped at once, within that delivery,
  with code 1011, so the object sees that connection close as it would in
  production, and nothing leaks into the next run (an end left unaccepted
  would stay in the object across evictions and keep its instance from
  being evicted). A connection the Worker answers itself, without an
  object, makes the run `UNSUPPORTED`.
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
  instance before the step runs and `ambiguous` is an attempt that
  outlives its `timeout` from its start, and `step_result` after it, where
  `crash_after` restarts it after the step ran and committed but before
  its result was persisted (so it runs again), and `ambiguous` is an
  attempt that ran but counted as failed just after its work (a timeout,
  which code sees as the engine's `WorkflowTimeoutError`), retried after
  its delay in virtual time. Step timeouts are measured: an attempt whose
  callback is still pending when its `timeout` (default 10 minutes) has
  passed in virtual time is timed out the same way (`step_timeout`). A
  timed-out attempt is not stopped, as the engine cannot stop it either
  (it races the callback against the timeout and discards what the
  callback later returns): it runs on as the late attempt, its effects
  the instance's, waited for like `waitUntil` work before the run ends and
  noted when it settles (`late_result`), and its result dropped. In a
  concurrent run its remaining effects are late turns (see Concurrent
  invocations): time may pass over them to the retry's delay, so the late
  attempt's call lands before, between or after the retry's or the
  recovery's, which is where a fence against a call still in flight is
  tested; a sequential run takes one order, the late attempt first unless
  it waits on a timer of its own. One limit: while the late attempt's call
  is inside an object napping on a timer of its own, the instance's own
  timers wait too (the retry's delay passes once the object wakes), as
  for any call into a napping object. A callback that throws is retried the same way,
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
  (`Workflow:<binding>`, table `instances`). `step.waitForEvent(name, {
  type, timeout })` and `instance.sendEvent({ type, payload })` follow
  Workflows, Events and parameters: an event sent before the wait is
  buffered and the wait returns it at once (`event`, with the payload); a
  wait with no event suspends the instance (`wait`; status `waiting`) until
  the event wakes it or its deadline passes (default 24 hours, in virtual
  time), when the wait throws a `WorkflowTimeoutError` the code may catch
  (`wait_timeout`). The suspension is the engine's hibernation, not an
  error: the wait's promise never settles and the run ends there, so no
  `catch` around the wait sees it and nothing after it runs until the
  wake (a step call from code still running alongside never settles
  either); resuming re-runs `run()` with the persisted results, as
  every restart does, and the wait's result or error is persisted by step
  name and count, so a later restart replays it. `sendEvent` is one effect
  with a stub call's faults (`send_event`), refused for a complete or
  errored instance or an invalid type. Current limits: a finished `sleepUntil` replayed after its time (Miniflare's
  engine throws there, and production behaviour is not documented), a step
  returning a stream or more than about 1 MiB (the engine refuses it, and
  Eutaxy cannot measure the stored size exactly), a retry delay function that throws, rollback handlers, `createBatch`
  and pausing, resuming, terminating or restarting an instance make the
  run `UNSUPPORTED`, as does a Workflow binding without a `workflow`
  setup step naming its class.

**Fidelity rules:**
- Proxies intercept calls but execute them against the real local
  implementation (Miniflare's D1 and storage), so SQL and storage semantics
  come for free. The Workflows engine is the exception (see above); the
  corpus checks the model against the local engine on fault-free runs.
- An allowlist of proxied bindings; anything else (Cache API, AI,
  Hyperdrive, raw sockets, a service binding without its `service` setup)
  makes the run `UNSUPPORTED`.
  Each kind on the allowlist is one record in `cloudflare` (`bindings.ts`):
  how an env value is recognised, the proxy the Worker sees, what is
  forgotten before a run, the reset its setup step asks for, the snapshot
  the run ends with and, for Durable Objects and Workflows, the delivery
  of the binding's own events (alarms, instance runs). The platform and
  the differential runner iterate the records in setup order and know no
  kind by name, so a new binding is one record and no change to either.
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
effects have different targets; starting an event, firing a timer
already due, and letting time pass over late turns are dependent on
everything (a timer's callback may do anything, and whether it is due
depends on virtual time), so what they run is never reordered and does
not count against the reduction. This assumes code between an invocation's effects shares no
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

How a run chooses is one object, the engine's `Chooser`: at each decision the
run puts the options to it, a fault (or none) at an effect point that may
take one, the next turn in a concurrent run, and takes the index it returns.
Seeded exploration, replay and exhaustive exploration are its three
implementations, built in `explore`: the seeded one draws from two streams
seeded by the run's seed (faults placed by the plan above, turns apart from
them), the replaying one looks a recorded schedule up, the enumerator picks.
The chooser also owns the seed of the run's virtual globals and whether its
turns must be recorded, and the fault bound (`maxFaultsPerRun`) is applied
to it, so the run loop holds no policy, and a new kind of decision is one
more question to the same object.

**Concurrent invocations.** With `maxConcurrentInvocations` above 1, up to
that many invocations are in flight, as concurrent requests are in one
isolate ("other requests may (or may not) be processed during awaiting any
`async` tasks", Cloudflare, How Workers works) and concurrent queue
consumers are up to `max_concurrency` (Cloudflare, Consumer concurrency).
Each
asynchronous effect is a turn: the invocation parks there, and once every
invocation in flight has parked, finished or gone idle, the engine lets
one parked invocation perform its effect and run to its next one, or,
while a slot is free, starts the next event, or fires the earliest virtual
timer already due (at or before the virtual now, which every effect
advances). A due timer is ready work like a parked effect: two jobs an
object starts on timers due at the same instant can each reach their
first effect before either's is performed, an order the runtime allows
and a lost update between such jobs needs. Timers keep their due order
among themselves (an event loop runs timers in deadline order, equal
timeouts in the order they were set: HTML Standard, timer initialization
steps), so one timer option per decision is enough. A timer not yet
due fires, and virtual time passes to it, only when nothing else can
move; an invocation that waits
on nothing Eutaxy can see makes the run `UNSUPPORTED`. One kind of parked
turn holds nothing: a late turn, an effect of code the platform has given
up on (`RunHooks.attempt`: a Workflow step attempt past its timeout,
which runs on because nothing can stop it) and whose remaining real time
is therefore unknown. A late turn is offered at every decision like any
other, but while only late turns are parked and nothing else is on
offer, letting time pass to the next timer or delayed event is an option
too, so what the late code still does lands before, between or after what
the invocation did since it gave up; once nothing else can move, the late
turns run. A run lets time pass over late turns at most a hundred times,
so a heartbeat cannot hold them off for good. The deadline that makes an
attempt late is the engine's own virtual timer, not a timer of the code's: it
leaves no trace and does not count as a read of the clock. The engine learns
that an invocation has parked, finished or gone idle from the run itself,
not from real time: a park, a delivery's end and real I/O completing wake
it. Before it decides, every continuation that progress set off must have
run, which takes one turn of the host's event loop: `setImmediate` where
that is cheap (Node), else the real zero timer the wait armed, which also
polls for the moves of a Durable Object's code, which cannot wake it (see
Durable Objects above), and gives code waiting on something unseen one
such turn before calling it idle. One turn per decision is the floor. In
workerd a zero timer is the only way to the event loop (streams, bodies,
message ports, crypto and the cache all resolve without one, except that
a body read inside a Durable Object takes a turn or more, so the scripted
`fetch` reads a text body as given and its reply answers `text()` and
`json()` from the known body within a microtask) and costs
about a millisecond, so a concurrent run there costs about that per turn
beyond its I/O; a bounded run of microtask hops cannot stand in for the
turn, since a strand of the invocation midway through plain awaits would
be cut off before its park and an interleaving lost. The pick among
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
to each timer's due time when it fires. Timers fire in due order and
never race real I/O: one invocation at a time, only while the invocation
is idle, meaning no effect is in flight; with several in flight, a timer
already due is a turn (see Concurrent invocations above). Platforms wait for handler and background promises
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
scenario's schema through the real binding, outside the effect log. SQL
that reads the time or draws randomness itself (`CURRENT_TIMESTAMP`,
`strftime(…, 'now')`, `random()`) reads SQLite's own clock and generator,
which the virtual ones do not reach: a row a schema file stamps that way
differs from run to run, and the replay check reports it, naming the
value that differed. Queue
messages are delivered one at a time; an unacknowledged message is
redelivered up to `max_retries` (default 3) and within the scenario's
`maxRedeliveries`, then dead-lettered, which the log records.

The CLI's `check` command generates a test file and invokes the user's
Vitest, rather than hosting workerd itself. That keeps the CLI free of
runtime dependencies. Concretely, `eutaxy check <scenario.sim.ts>` writes a
`.eutaxy/` directory beside the scenario holding a test that performs the
check inside workerd and a Vitest config with the Cloudflare plugin pointed
at the wrangler config the scenario names (or given with `--wrangler`;
for a scenario that does not load in Node, the one beside it). The test holds only the Vite globs (they resolve at build
time, so they must be written in it) and one call to `checkInWorkerd`, a
typed function of the `cli` package that resolves the Worker and schema
files from the scenario's own `worker.entry` and `setup` (one outside the
scenario's directory, where the globs do not reach, the test imports by
name), observes the
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
time. Its vocabulary, `constructs.json`, names each construct and whether
each engine takes it; every construct has an entry of its own, and a
test checks the vocabulary against the outcomes those entries expect.
Today the subset is: exported functions, declared or held as an
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
member has: its tag), `Number.isInteger`, `Math.floor` and `/` (as
JavaScript computes them on doubles; `Number` and `Math` are the
built-ins only where the compiler resolves the name to its standard
library, so a declaration, import or block-scoped shadow in scope, even
one declared after the use, makes it something else, and a type-only
import does not), module-level constants, and calls to the module's own
functions. A module-level `const` holding a number, boolean or string
built from literals, operators and other such constants, the module's
own or one it imports (resolved as the compiler resolves it), is read as
its value wherever it is named, which a `const` makes exact; a `let` or
`var` may be rebound and is outside, as is a constant holding a record,
calling a function, or reaching itself. A spec file does not read the
module's constants yet: its claims spell the values. A generic function, and a function imported from another file
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
it is being read (recursion) is outside the subset. So is a function the
compiler reports an error in, with the compiler's message, however it
reads (a `const` used before its declaration throws where the reader
would see a value), and one holding a `@ts-ignore` or `@ts-expect-error`
comment, which hides such an error. A direct assignment to a global of
the compiler's standard library or to a property of one (`Math.floor =
…`, `Array.prototype.map = …`, `Math = …`), or through `globalThis`,
`self` or `window`, anywhere in a read file, inside a function or not,
puts every function and constant of that file outside (in the spec file,
which runs whenever it is imported, it is an error), as does a
`@ts-nocheck` comment, which turns the compiler's checks off; every
`PROVEN` states the assumption that the built-ins are the standard ones,
since an assignment made another way (`Object.defineProperty`, through
an alias) or elsewhere (a polyfill, another module) is not seen. A record may be a
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
takes first; the SMT engine does not take lists. The Lean engine, whose
numbers are the integers, takes division only as `Math.floor(x / c)` for
a positive integer constant `c` (Lean's `Int` division, which rounds
toward negative infinity as `Math.floor` does, and which `omega`
decides), and `Math.floor` of anything else as the identity; the SMT
engine takes `/` and `Math.floor` on doubles (`fp.div` and
`fp.roundToIntegral` toward negative infinity), checked against
JavaScript on test262's edge values. A function using what
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
(`leanToolchain`), found in Eutaxy's cache first, where `eutaxy prover
install lean` puts it, then through `elan`, Lean's toolchain manager, only
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
release (`z3Version`), found in Eutaxy's cache first, where `eutaxy prover
install smt` puts it, then on the PATH, and required to report that
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
- Provers opt-in: `eutaxy prover install lean` and `eutaxy prover install
  smt` put the pinned toolchain on the machine, and nothing else does:
  never `optionalDependencies`, never a download during a check or on
  `npm install`; an engine named but not installed yields `UNKNOWN`
  (`unavailable`) with the command. Each engine's module holds, beside its
  version pin, a table of the upstream release files for the platforms
  Eutaxy runs on (Linux and macOS on x64 and arm64, Windows on x64): the
  URL, the SHA-256 and the size of the file in the upstream GitHub release
  (Lean's `tar.zst`, Z3's `zip`), and a test holds the table to the pin.
  The command downloads the file for the current platform into Eutaxy's
  cache directory (`EUTAXY_CACHE_DIR`, else the platform's user cache:
  `$XDG_CACHE_HOME/eutaxy` or `~/.cache/eutaxy` on Linux,
  `~/Library/Caches/eutaxy` on macOS, `%LOCALAPPDATA%\eutaxy\Cache` on
  Windows), checks the SHA-256 before unpacking anything (a mismatch deletes
  the download and installs nothing), unpacks into
  `toolchains/<name>/<version>` beside a marker file naming the file and
  its checksum, and deletes the archive. `--from <url or directory>`
  replaces the download host with a mirror or an offline copy holding the
  same file names, for CI behind a proxy or an air-gapped machine, the
  checksum check unchanged; `--json` prints what was installed, from where
  and the checksum checked, and a toolchain already in the cache is reported
  and not downloaded again. The engines look in the cache first, then where
  they looked before (elan and the `PATH` for Lean; `EUTAXY_Z3`, the `PATH`
  and the package managers' prefixes for Z3), so a toolchain installed by
  hand still serves. Upstream files are taken as published because
  rebuilding the toolchains would mean a build matrix and hosting to secure;
  Lean's release file is 570 to 620 MB per platform and about 2.8 GB unpacked
  (the compiler ships its C toolchain), the same download elan makes, and a trimmed bundle (the
  binary and `Init`, all the emitted modules load) is built only if a
  target's CI minutes call for it. Eutaxy reads the archives itself (tar
  over Node's zstd, zip over its inflate), so the command needs nothing but
  Node; an entry that would write outside the toolchain directory is
  refused. Projects list engines in `eutaxy.config.ts`.
- Split into separate packages later only for a reason, most likely a
  prover engine. Released in lockstep with exact version pins.

| Command                        | Does                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `eutaxy check <spec>`          | Run a scenario; print the verdict and the shrunk trace, write a regression test     |
| `eutaxy draft [config]`        | Write a scenario skeleton from a wrangler config and the Worker module it names     |
| `eutaxy report [dir]`          | Run the spec ladder on every spec file under a directory, without a scenario        |
| `eutaxy prover install <name>` | Put the pinned Lean or Z3 release for this platform in the cache, checksum-verified |
| `eutaxy mcp`                   | Serve the Model Context Protocol over stdio for a coding agent                      |

`report` covers the pure core and needs only Node: it imports each module
and its spec file, runs `TESTED` and, with `--prover`, `PROVEN`, and prints
the verdicts by module. Scenario verdicts stay with `check`, since a
scenario runs inside workerd under a budget and running all of them is the
job of the project's test suite, which the regression tests already join.
A spec file run by itself needs no separate command: `report` on its
directory is that.

`draft` is the first scenario's starting point, and it guesses nothing it
cannot read. The wrangler config (JSON or JSONC) gives the setup: each D1
binding with its schema file (`schema.sql`, `<database_name>.sql`, or the
only `.sql` file beside the config), each Durable Object, R2 bucket and
Workflow the Worker owns, and each service binding as a `callee()` when a
wrangler config of that Worker's name is found under the directory,
otherwise as a scripted `service()`. The drive follows the Worker's entry
points: a queue consumer, else a Cron Trigger, else an Agent's route
(`routeAgentRequest` in the code), else `fetch()`. The externals are the
hosts the code fetches by a literal URL, in the module and the modules it
imports by relative path. The invariants and the drive's events are left
as holes marked TODO, with example invariants for the bindings found as
comments: what must hold is the author's to say, and a scenario with no
invariant does not check. Bindings the simulation does not proxy, other
drives the Worker also has and every guess are written into the file as
notes. Nothing is imported or run, so a draft costs nothing and cannot
fail on the Worker's own imports; the source is scanned as text, which is
why a URL built at run time is not found.

**The agent loop.** `eutaxy mcp` serves the Model Context Protocol over
stdio (one JSON-RPC message per line, logs on stderr, exit when stdin
closes), written with the standard library alone, so a coding agent runs
"check, read the report, fix or prove, check again" through one tool.
It speaks both eras of the protocol: the stateless `2026-07-28` revision,
every request carrying its version and client capabilities in `_meta` and
`server/discover` answering the versions served, and the `2025-11-25`
revision and its predecessors with the `initialize` handshake today's
clients open with; a request names its era by carrying `_meta` or not,
and the result is shaped for it (`resultType` and the server's identity
in the stateless one). The tools are pure functions of the repository's
files, each returning the JSON report as structured content beside its
text: `check` (a scenario, the `check` options; on a violation the
report names the regression test written, `regressionTest`), `draft` (a
wrangler config and optionally the Worker module and where to write;
the source, the draft as data and its notes), `report` (a
directory, the engines), `goals` (the Lean engine's open goals under a
directory, written beside each spec file), `prove` (one spec file's
module, with the proofs supplied beside it) and `prover_status` (the
installed toolchains). A verdict is a result whatever it says; a command
that could not run, or an argument that does not fit, is a tool error
(`isError`) with the text the model can act on, and an unknown tool or
method a protocol error. Resources, prompts, subscriptions and the HTTP
transport are not served. Eutaxy never calls a model: every verdict
depends only on files in the repository, and the server adds no state of
its own.

**Goal files.** The Lean engine lists its open goals with every report
Lean answered: each `forall` property its tactic script gave up on, with
the statement it emitted and Lean's first diagnostic line (`goals` in the
engine's report, empty when every proof closed and absent when the engine
could not run or finish, so no answer is never taken for no open goals). `eutaxy report --goals` (and the `goals` tool) writes a module's
open goals beside its spec file as `<spec>.goals.lean`, in the form of the
proof file the engine already accepts (`domain.props.lean`): the goals
described in comments, then one `-- proof:` part per goal with nothing
under it, and two header lines naming the SHA-256 of the module source and
of the spec file the goals were written for. Copied to `domain.props.lean`
and filled with lemmas and tactics, it is a supplied proof file and is
checked as one: nothing new is trusted, and the template avoids every word
a proof file may not use. A proof file that carries the two hash lines is
stale once either file changed: its proofs are not used, and the engine
answers `UNKNOWN` (`gave_up`, saying which file moved) for every property
it names, so none reaches `PROVEN`, rather than failing one by one on a
statement that moved under them; a proof file without the lines is checked
as before. No open goal removes a goal file left from an earlier run; no
answer leaves it. Every generated line of a goal file is checked against
the words a proof file may not use (a function named by a refused word
appears by its Lean identifier; a diagnostic holding one is left out with
a note), so the template is always accepted as copied.

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
  and the final D1 tables, R2 objects and Durable Object storage must agree
  (the raw side reads every seeded object, since no proxy saw which were
  reached, and counts a stub call as I/O in flight, as the call crosses
  workerd unseen). Any divergence is a bug in Eutaxy's
  proxies or platform model. The raw side shares Eutaxy's reading of the
  queue semantics but none of the proxy code. The proxied side, the raw
  side's loop (the same virtual globals and scripted externals, the same
  pick of the next event, the same redelivery rule) and the comparison are
  platform-neutral and live in `engine`; each platform writes only how one
  raw attempt calls its handler and what an attempt's record holds.
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
