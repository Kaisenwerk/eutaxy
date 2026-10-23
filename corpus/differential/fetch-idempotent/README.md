# fetch-idempotent

The `queue-charge-twice` consumer with the fix applied: every charge carries
an `Idempotency-Key`. The scripted payments external declares that it
deduplicates by that header, so a retried request is replayed rather than
charged again. The differential test checks the proxied and raw runs agree,
and the check shows both invariants holding under crash, ambiguous-outcome
and error faults at the fetch and at the acknowledgement.
