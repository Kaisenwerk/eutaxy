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
