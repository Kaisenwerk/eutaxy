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

/**
 * The handler object a `WorkerEntrypoint` class stands for when it is the Worker's default export: each
 * of `fetch`, `queue` and `scheduled` the class defines constructs it anew with the invocation's env and
 * ctx, as workerd does per event, and calls the method with the event alone (its env and ctx are on the
 * instance) (developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
 */
export function entrypointHandler(cls: unknown): {
  readonly [handler in "fetch" | "queue" | "scheduled"]?: (
    event: never,
    env: unknown,
    ctx: unknown,
  ) => unknown;
} {
  const proto = (typeof cls === "function" ? cls.prototype : undefined) as
    | Record<string, unknown>
    | undefined;
  const out: Record<string, (event: never, env: unknown, ctx: unknown) => unknown> = {};
  for (const name of ["fetch", "queue", "scheduled"] as const)
    if (typeof proto?.[name] === "function")
      out[name] = (event, env, ctx) => {
        const instance = constructEntrypoint(cls, "WorkerEntrypoint", ctx, env) as Record<
          string,
          (event: unknown) => unknown
        >;
        return (instance[name] as (event: unknown) => unknown).call(instance, event);
      };
  return out;
}
