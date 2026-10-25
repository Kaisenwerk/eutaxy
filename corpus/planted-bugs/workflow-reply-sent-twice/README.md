# workflow-reply-sent-twice

**The bug.** A chat webhook starts one Workflow instance per message,
keyed by the message id, and answers at once. The Workflow generates a
reply with a model API in one step and posts it to the chat API in the
next. The post carries no idempotency key. Cloudflare persists a step's
result once it returns, and may restart an instance or retry a step at
any point before that, so a post that went out before the result was
persisted is made again: the user gets the reply twice.

**Why it matters.** Locally the engine never restarts between a step's
side effect and the persisting of its result, so every test passes. Here
the engine is a model that restarts there, and retries an attempt that
ran but counted as failed.

**What Eutaxy must report.** `VIOLATED` on `reply-sent-once`, with two
effective posts for `msg-1`: one before the restart (or the failed
attempt) and one after. `one-run-per-message` holds: the webhook keys the
instance by the message id, so a resent webhook finds it already there.
`FixedChatTurn`, which sends the message id as the post's idempotency
key, is `BOUNDED`, seeded and exhaustively: the repeated post is
deduplicated.

**The fix.** Make every non-idempotent call inside a step idempotent,
here with a key derived from the message.

The entry also checks the model against Miniflare's engine on a run with
no faults (`CountingFlow`: a step repeated by name, a step that fails its
first attempt, a sleep), and that the model's errors for a duplicate id
and an unknown instance are the binding's.
