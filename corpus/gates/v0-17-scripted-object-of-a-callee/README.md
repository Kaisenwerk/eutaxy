# v0-17-scripted-object-of-a-callee

The scripted Durable Object (`docs/roadmap.md`, "Patch work") where a
system split into Workers has it: in a Worker the scenario's own Worker
calls, run through `eutaxy check`.
- **The Workers**: the front Worker starts a job on the jobs Worker,
  through a service binding by RPC. The jobs Worker's pool object claims
  the job and boots a machine for it: an object of a second namespace of
  the jobs Worker's, backed by a container.
- **The model**: the jobs Worker runs for real (`callee("JOBS", …)`),
  its pool is the real object (`durableObject("jobs/POOL")`), and its
  machines are scripted under the Worker's name
  (`scriptedObject("jobs/MACHINE", …)`). The command builds the isolate
  from both wrangler configs, the machine's class in it; that class
  throws from its constructor, and no run ever constructs it.
- **The cells**: no faults, two in flight, where every job ends running
  (which it could not if a machine were asked for real); and one fault a
  run, anywhere, with one and with two invocations in flight: `BOUNDED`,
  nothing unsupported.

The invariants: a machine that was booted is a job the pool has on
record, and a job recorded as running carries its machine's address.
