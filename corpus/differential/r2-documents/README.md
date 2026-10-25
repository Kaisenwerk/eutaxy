# r2-documents

A document store over one R2 bucket. Each request puts a temporary object
and a document with custom and HTTP metadata, reads the document back
(body and head), reads the seeded document through its stream, updates it with a put conditional on the etag it read,
tries a second put on that now stale etag (which must store nothing),
lists the documents two at a time (passing each cursor back), copies the temporary object by handing its
body to another put, and deletes both. The bucket is
seeded with one document. The differential test checks the proxied and
raw runs agree on every response and on the final objects, text and
metadata included; the check shows the invariants holding under faults at
every call.
