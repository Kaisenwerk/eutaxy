/**
 * Decisions built with an imported result kit: the generic helpers are
 * read at each call, at the types the compiler infers there, so the
 * decision is proved over what it returns.
 */

import { err, ok, type Result } from "./kit.ts";

export type Refused =
  | { readonly type: "invalid" }
  | { readonly type: "expired" }
  | { readonly type: "locked" };

export const judge = (attempts: number, matches: boolean): Result<true, Refused> =>
  matches ? ok(true) : attempts >= 5 ? err({ type: "locked" }) : err({ type: "invalid" });

/** The same error type in a second Result: one member record, two unions. */
export const remaining = (attempts: number, matches: boolean): Result<number, Refused> => {
  if (matches) return ok(5 - attempts);
  return err({ type: "invalid" });
};

/** An error from one Result returned as another: the member moves between the two unions. */
export const attemptsLeft = (attempts: number, matches: boolean): Result<number, Refused> => {
  const verdict = judge(attempts, matches);
  if (!verdict.ok) return verdict;
  return ok(5 - attempts);
};
