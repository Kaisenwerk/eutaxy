/**
 * One error record in two results: `Err<Reason>` is a member of both
 * `Result<boolean, Reason>` and `Result<number, Reason>`, and an error from
 * the first is returned as the second.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export type Reason = { readonly kind: "empty" } | { readonly kind: "full" };

export function admit(load: number, capacity: number): Result<boolean, Reason> {
  if (load <= 0) return { ok: false, error: { kind: "empty" } };
  if (load > capacity) return { ok: false, error: { kind: "full" } };
  return { ok: true, value: true };
}

export function room(load: number, capacity: number): Result<number, Reason> {
  const admitted = admit(load, capacity);
  if (!admitted.ok) return admitted;
  return { ok: true, value: capacity - load };
}
