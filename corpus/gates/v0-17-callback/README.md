# v0-17-callback

The second part of the v0.17 gate (`docs/roadmap.md`, "Inside the object"):
an object calling a real Worker, and that Worker being the one that called.
- **The front Worker** (the scenario's own): a request starts a Workflow,
  which asks the turns Worker to run a turn and waits for the event that
  says it ended, a minute at most; then it delivers the reply, by the event
  or, had none come, by asking.
- **The turns Worker** (a `callee()`): one object per turn. `start` records
  the turn and answers; the work behind the answer asks the model Worker
  (scripted) and calls back into the front Worker through the object's own
  service binding. A notice that got no answer is sent once more.
- **The cycle**: the scenario names the turns Worker's binding back to the
  front Worker as a callee whose entry and config are the scenario's own.
  The command takes it for what it is: the front Worker's `Notices`
  entrypoint runs as an invocation hosted inside the object's call, with
  the scenario's env under its own names, and sends the event that wakes
  the Workflow.

Run through the command (`scenario.node.test.ts`), which builds the isolate
from both wrangler configs:
- `requests.sim.ts`: two in flight, no faults. `BOUNDED`, with the invariant
  that every reply came by the event: the Workflow never has to ask.
- `faulted.sim.ts` and `sequential.sim.ts`: one fault a run, two in flight
  and one at a time. `BOUNDED` with nothing unsupported: one reply and one
  notice per request, and a reply that came by the event is the model's.
- `planted.sim.ts`: the front Worker of `worker.planted.ts`, which records
  every notice it is sent. `VIOLATED` on `one-notice-per-request`, by an
  answer lost inside the call back.

There is no differential entry: the comparison runs one Worker in the
isolate against the local runtime, and the local runtime under the test
plugin holds no second Worker to call.
