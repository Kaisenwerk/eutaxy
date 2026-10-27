# refund-lost-update

A refund endpoint with a pure core, `decideRefund` in `domain.ts`, and a
shell in `worker.ts` that reads the order, asks the core, and writes the
refunded total the core computed.

**The shell's bug: a lost update.** Two refunds of one order in flight at
once both read a refunded total of 0, both are approved, and the second
write overwrites the first. The order shows one refund; two were granted.
Each decision is right for the state it was made on, so no check of the
decision alone can see it. `refines` can: the second write carries out a
decision whose read another invocation's write had made stale before the
write committed. The fix, `fixed` in `worker.ts`, writes only when the
total is still the one it read (compare and set), so the late write
changes nothing and the caller is asked to retry.

**The core's bug: an off-by-one.** `decideRefund` rejects a refund that
brings the total exactly to the captured amount (`>=` where `>` was
meant). Rejecting is safe, so no system invariant notices; the property
`fullRefundAllowed` on `decideRefund` in `domain.props.ts` is REFUTED. In the
sequential scenario the simulator itself passes an input that shows it
(600 refunded, 400 asked, 1000 captured) once one refund has landed
before the other, and the `CHECKED` rung reports that call. In the
concurrent scenario the violation stops the exploration before the
simulator reaches such an input, and the `TESTED` rung finds one among the
inputs it generates and shrinks it. The other two properties hold on the
simulator's inputs and on the generated ones, so they are TESTED, and with
`--prover lean` the first-party engine proves them for every input:
PROVEN. A fourth property, `totalNonNegative`, is stated without the
integer guard: it holds over the integers and fails for a `NaN` amount.
Sampling with the corpus seed happens to miss that amount, so the rung
says TESTED, and `--prover lean` then says PROVEN under its integer model.
`--prover lean,smt` finds the `NaN` as a model, replays it, and reports
the two engines' disagreement as a `CONFLICT`: what the SMT engine is
for.
