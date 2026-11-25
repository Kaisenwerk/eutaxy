/**
 * A clock that does not move, for a check whose test asserts that
 * exploration ran every schedule (`reached.exhaustive.complete`). The
 * scenario's time budget then never ends the exploration early, so the
 * claim rests on the cap on runs (`maxRuns`) and on the test's own
 * timeout, not on how fast the runner is that day: a loaded CI runner has
 * taken thirty times a test's usual second. The budget still bounds each
 * effect's real I/O, and the verdict's `elapsedMs` reads 0.
 */
export const untimed = (): number => 0;
