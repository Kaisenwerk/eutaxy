/**
 * Constructing an entrypoint class (`WorkerEntrypoint`, `WorkflowEntrypoint`)
 * outside the runtime, for the one `new` per call or instance run that the
 * models make themselves.
 */

/** Sets `ctx` and `env` as the runtime's base classes do, for the one `new` workerd would refuse. */
class StandInEntrypoint {
  readonly ctx: unknown;
  readonly env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Construct a subclass of the entrypoint base class named `base`. workerd's
 * base constructors accept only a native ExecutionContext, so for this one
 * synchronous `new` the class that extends the base directly extends a
 * stand-in instead; its own constructor and field initialisers run as
 * written, and the base is put back before anything else can run.
 */
export function constructEntrypoint(
  cls: unknown,
  base: "WorkerEntrypoint" | "WorkflowEntrypoint",
  ctx: unknown,
  env: unknown,
): object {
  if (typeof cls !== "function") throw new TypeError("not a class");
  let direct = cls as object;
  for (;;) {
    const parent = Object.getPrototypeOf(direct) as unknown;
    if (typeof parent !== "function" || parent === Function.prototype)
      throw new TypeError(`${(cls as { name: string }).name} does not extend ${base}`);
    if ((parent as { name: string }).name === base) break;
    direct = parent;
  }
  const original = Object.getPrototypeOf(direct) as object;
  Object.setPrototypeOf(direct, StandInEntrypoint);
  try {
    return Reflect.construct(cls as new (...a: unknown[]) => object, [ctx, env]);
  } finally {
    Object.setPrototypeOf(direct, original);
  }
}
