/**
 * What a spec file writes: `forall(f, { when, ensures })` and `total(f)`.
 * Both return plain data holding the function itself, so the user's
 * compiler types the arrows' parameters as `f`'s and a spec that does not
 * match its function does not compile. Nothing here runs a check: the
 * simulator's rungs evaluate the arrows on inputs, and the engines read
 * the spec file's text.
 */

/** Any function; `never[]` so that every parameter list is accepted. */
export type Fn = (...args: never[]) => unknown;

/**
 * A universally quantified claim: for every input of `fn`'s parameter
 * types where `when` holds, `ensures` holds. `ensures` is evaluated only
 * where `when` does, so a guard such as `c !== null` protects what follows.
 */
export interface Forall<F extends Fn> {
  readonly kind: "forall";
  readonly fn: F;
  readonly when?: (...args: Parameters<F>) => boolean;
  readonly ensures: (...args: Parameters<F>) => boolean;
}

/** The claim that `fn` terminates on every input of its parameter types. */
export interface Total<F extends Fn> {
  readonly kind: "total";
  readonly fn: F;
}

export type Spec = Forall<Fn> | Total<Fn>;

export function forall<F extends Fn>(
  fn: F,
  property: {
    readonly when?: (...args: Parameters<F>) => boolean;
    readonly ensures: (...args: Parameters<F>) => boolean;
  },
): Forall<F> {
  return {
    kind: "forall",
    fn,
    ...(property.when === undefined ? {} : { when: property.when }),
    ensures: property.ensures,
  };
}

export function total<F extends Fn>(fn: F): Total<F> {
  return { kind: "total", fn };
}

/** Whether a spec file's export is one of the two spec shapes. */
export function isSpec(value: unknown): value is Spec {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown; fn?: unknown; ensures?: unknown; when?: unknown };
  if (typeof v.fn !== "function") return false;
  if (v.kind === "total") return true;
  return (
    v.kind === "forall" &&
    typeof v.ensures === "function" &&
    (v.when === undefined || typeof v.when === "function")
  );
}
