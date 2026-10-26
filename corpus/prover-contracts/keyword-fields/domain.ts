/** Record fields named like Lean keywords: the emitted structure quotes them, in declarations and in reads. */

export interface Span {
  readonly from: number;
  readonly end: number;
}

/**
 * @ensures{ordered} forall (from: int) (len: nat) { span(from, len).end >= span(from, len).from }
 * @ensures{length} forall (from: int) (len: nat) { span(from, len).end - span(from, len).from === len }
 */
export function span(from: number, len: number): Span {
  // biome-ignore lint/complexity/useMathMinMax: Math is outside the subset; the conditional operator is in it
  return { from, end: from + (len < 0 ? 0 : len) };
}
