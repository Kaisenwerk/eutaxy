# v0-13-agent-board

The v0.13 gate (`docs/roadmap.md`, "Durable Objects on SQLite, and
Agents"): an object written the way the phase's target writes its
objects, an Agents SDK class on SQLite storage with a schedule and
WebSocket connections, run with no `UNSUPPORTED` verdict.
- **State and `this.sql`**: each posted item goes into the Agent's own
  `items` table and its count into the Agent's state.
- **A schedule**: the first item schedules a `digest` 30 seconds out; the
  SDK runs it over the object's alarm, which fires in virtual time after the
  posts, and the digest counts every item.
- **WebSocket connections**: two clients connect through the SDK's router,
  are welcomed on connect, post their items at once (an external screening
  call in between, where a lost update would hide), and are each told the
  new count.

The scenario must be `BOUNDED`: the count is taken before the outbound call,
so two posts at once cannot lose one. The second test shows a fault-free
run crossing every boundary and the snapshot of the Agent's tables.
