/**
 * A generic alias instantiated in a signature: the compiler expands it,
 * and the reader names the instantiation as the compiler prints it.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface Locked {
  readonly type: "locked";
  readonly until: number;
}

export function judge(attempts: number, matches: boolean): Result<number, Locked> {
  if (!matches) return { ok: false, error: { type: "locked", until: attempts + 1 } };
  return { ok: true, value: attempts };
}
