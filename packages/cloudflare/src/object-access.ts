/**
 * Code run inside a Durable Object as one of its own events does (an alarm,
 * a WebSocket message), and the crash semantics that go with it: the effect
 * hosts the object's effects, an abandoned effect resets the object, an
 * effect inside blockConcurrencyWhile may not wait for a turn, and a crash
 * drops the instance, whose in-memory state goes with it.
 */

import type { EffectPoint, Invocation, JsonValue, RunHooks } from "@eutaxy/core";
import { type Outcome, runInvocation } from "@eutaxy/engine";

/** What a delivery into an object needs of its namespace: to run code inside one, and the crash semantics. */
export interface ObjectAccess {
  run<T>(
    binding: string,
    id: string,
    object: string,
    fn: (instance: unknown, live: DurableObjectState) => Promise<T>,
  ): Promise<T | undefined>;
  abort(binding: string, id: string): void;
  mayPark(binding: string, id: string): boolean;
  evict(binding: string, id: string): Promise<void>;
}

/**
 * One effect of `inv` performed inside the object `id` of `binding`: `perform`
 * runs as the effect, which hosts what the object does; a fault that
 * abandons it resets the object, and a crash evicts the instance. The
 * invocation's outcome.
 */
export async function hostedInObject<T>(
  hooks: RunHooks,
  inv: Invocation,
  objects: ObjectAccess,
  binding: string,
  id: string,
  point: EffectPoint,
  perform: () => Promise<T>,
  summarize: (value: T) => JsonValue,
): Promise<Outcome<T>["status"]> {
  const { status } = await runInvocation(hooks, inv, () =>
    hooks.effect({ ...point, hostsEffects: true }, perform, summarize, {
      onAbandon: () => objects.abort(binding, id),
      mayPark: () => objects.mayPark(binding, id),
    }),
  );
  if (status === "crashed") await objects.evict(binding, id);
  return status;
}
