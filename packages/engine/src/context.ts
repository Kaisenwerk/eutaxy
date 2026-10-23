/**
 * Async context, where the host has it. Node's AsyncLocalStorage (also in
 * workerd with Node compatibility) follows promise chains, I/O callbacks
 * and continuations, so a value set around a call is visible to every piece
 * of code that call goes on to run, whenever it runs. Reached through
 * `process.getBuiltinModule`, so a host without it still loads the engine.
 */

export interface AsyncScope<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

/** A new async context slot, or null where the host has no AsyncLocalStorage. */
export function asyncScope<T>(): AsyncScope<T> | null {
  const mod =
    typeof process !== "undefined"
      ? (process?.getBuiltinModule?.("node:async_hooks") as
          | { AsyncLocalStorage?: new () => AsyncScope<T> }
          | undefined)
      : undefined;
  return mod?.AsyncLocalStorage ? new mod.AsyncLocalStorage() : null;
}
