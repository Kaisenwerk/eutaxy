# v0-13-websocket-connections

Toward the v0.13 gate (`docs/roadmap.md`, "Durable Objects on SQLite"): a
Durable Object on the WebSocket Hibernation API, as one is written for it,
driven over connections.
- **Two clients in one room**: each connection is accepted with a tag and an
  attachment, every message is counted in storage and echoed back with its
  number, and a crash is allowed on any send: the instance is dropped, the
  runtime keeps the connections, and the next message finds its server end
  again in the new instance (by attachment and tags). `BOUNDED`, nothing
  unsupported; a replay with the crash placed shows the message after it
  delivered.
- **A server-side close**: `bye` makes the room close the connection, so the
  client's next message is recorded as not delivered and the close is
  recorded as the object's.
- **A client turned away**: the room closes the socket before answering the
  upgrade; the close is recorded as the object's and the client's message
  as not delivered.
- **The runtime's auto-response**: a room on `setWebSocketAutoResponse` is
  refused (`UNSUPPORTED`), since Eutaxy delivers messages to the handler
  itself and would answer what the runtime answers without waking the
  object.
- **A Worker that dies during an open**: the end it held is dropped within
  that delivery, so the room counts that close (code 1011) before the
  snapshot; the connections still open at the end are torn down after the
  snapshot, outside the run.
