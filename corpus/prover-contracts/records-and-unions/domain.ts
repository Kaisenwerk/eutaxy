/**
 * A record parameter is in the subset (a structure); a nullable record, a
 * union of literals and a tagged-union result are outside it for now and
 * belong to the SMT engine first. The simulator's rungs check all of them.
 */

export interface Challenge {
  readonly attempts: number;
  readonly locked: boolean;
}

export type Refused = { readonly type: "invalid_code" } | { readonly type: "code_locked" };

export type Outcome =
  | { readonly ok: true; readonly value: Challenge }
  | { readonly ok: false; readonly error: Refused };

export function bump(c: Challenge): Challenge {
  return { attempts: c.attempts + 1, locked: c.attempts + 1 >= 5 };
}

export function admit(c: Challenge | null, matches: boolean): Outcome {
  if (c === null) return { ok: false, error: { type: "invalid_code" } };
  if (c.locked) return { ok: false, error: { type: "code_locked" } };
  if (!matches) return { ok: false, error: { type: "invalid_code" } };
  return { ok: true, value: c };
}

export function decideAccess(
  status: "invited" | "active" | "disabled" | null,
): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}
