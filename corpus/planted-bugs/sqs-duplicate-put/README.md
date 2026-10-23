# sqs-duplicate-put

**The bug.** The Lambda writes each payment with `crypto.randomUUID()` as the
sort key. SQS delivers at least once: if the function dies after the write
but before Lambda deletes the message, the message is redelivered and the
order is recorded a second time under a new key.

**Why it matters.** This is the AWS twin of `queue-duplicate-write`: the
same shape of money bug, found the same way, with the SDK call as the
effect boundary instead of a D1 binding.

**What Eutaxy must report.** `VIOLATED` on `payment-recorded-once`, keyed on
the order id attribute of the committed `PutItem`.

**The fix.** Key the item by the order id and make the put conditional
(`attribute_not_exists(pk)`), then treat `ConditionalCheckFailedException`
as already done, as the platform tests do.
