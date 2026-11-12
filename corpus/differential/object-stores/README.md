# object-stores

An object keeps files in two stores outside itself, both reached through
its own `env`: the bytes in an R2 bucket, put inside the call it is
serving, and the catalogue row in a D1 database, written in a batch in
work the answer does not wait for. Its constructor loads the size limit
from the database behind its input gate, and a read gets a file's bytes
and its row back. Under Eutaxy each of those statements and bucket
operations is an effect of the invocation the object's code runs as; in
the raw run the object uses the real bindings natively. The two must
agree on every answer and on what the database, the bucket and the
object's own tables hold.

The work after the answer starts at once, with no timer: nothing drives
the object's virtual timers in the raw run (`docs/design.md`, Durable
Objects).
