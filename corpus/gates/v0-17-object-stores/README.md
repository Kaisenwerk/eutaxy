# v0-17-object-stores

The part of the v0.17 gate (`docs/roadmap.md`, "Inside the object") for an
object's stores: a statement an object runs on a D1 database and an
operation it makes on an R2 bucket, through its own `env`, are the
scenario's.
- **The object**: `add` puts a file's bytes in the bucket inside the call
  it is serving, records the file in its own storage, sets a watchdog
  alarm and answers; the work behind the answer writes the catalogue row
  to the database and marks the file listed. The watchdog lists whatever
  is still only stored. The constructor loads the size limit from the
  database behind its input gate. Every write outside is one that can be
  made twice (the same bytes under the same key, a row keyed by the
  file's name), so a resend or the watchdog crossing a window a fault
  opened counts nothing twice.
- **The model**: each statement and bucket operation the object makes is
  an effect a fault can land on: `file-1#1 call D1:DB first` while the
  first call constructs the object, `file-1#1 call R2:BUCKET put` inside
  the call, and `DO:LIBRARY/lib/after call D1:DB run` in the work after
  the answer. Each leaves the object once its earlier writes are durable,
  as behind the output gate.
- **The cells**: one and two invocations in flight, up to two faults,
  each `BOUNDED` with nothing unsupported; every schedule with one fault,
  exhaustively.
- **The replays**: where the object's operations are recorded; the same
  seed giving the same run, and two in flight interleaving them by the
  seed; the catalogue row written and its answer lost (the watchdog
  writes it again, once); the object reset right after its bytes were put
  (the next call constructs it and loads the limit again, the resend puts
  the bytes again); and the constructor's read failing, which breaks the
  object's input gate: the runtime resets the object, the call fails, and
  the resend finds it constructed anew.

The invariants: a file the object recorded as listed is in the catalogue,
the catalogue never names a file whose bytes are not in the bucket, and
nothing over the limit is stored.
