/**
 * Observe a module's pure core functions while runs are installed: each call
 * from outside the module is recorded with its arguments, for spec checks
 * on the inputs the simulator passed, and logged as a decision of the
 * invocation that made it (`Core:<function>`, payload `{ args, result }` or
 * `{ args, error }`), for `refines`. Calls the module makes to itself do not
 * go through its exports and are not seen.
 *
 * Observing replaces the export on the module's namespace object, which
 * works where a bundler or test runner gives modules a namespace with
 * configurable properties (Vite, so Vitest and the Cloudflare plugin); a
 * native ESM namespace is frozen, and the function is reported unobservable.
 */

import { type JsonValue, toJson } from "@eutaxy/core";
import { patchProperty } from "./patch.ts";
import { installedRun } from "./run.ts";

export interface ObservedCall {
  readonly function: string;
  /** The arguments as passed; primitives exactly, objects by reference. */
  readonly args: readonly unknown[];
  readonly threw: boolean;
}

export interface CoreObserver {
  readonly calls: readonly ObservedCall[];
  /** Functions that could not be observed, with why. */
  readonly unobservable: { readonly [fn: string]: string };
  /** Put the original exports back. Safe to call twice. */
  restore(): void;
}

export function observeCore(namespace: object, functions: readonly string[]): CoreObserver {
  const calls: ObservedCall[] = [];
  // No prototype: a function named __proto__ is an ordinary key.
  const unobservable: { [fn: string]: string } = Object.create(null);
  const undo: (() => void)[] = [];
  const target = namespace as Record<string, unknown>;
  for (const name of functions) {
    const original = target[name];
    if (typeof original !== "function") {
      unobservable[name] = `the module exports no function ${name}`;
      continue;
    }
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const run = installedRun();
      if (!run) return Reflect.apply(original, this, args);
      const record = (threw: boolean, payload: { result: JsonValue } | { error: string }) => {
        calls.push({ function: name, args: [...args], threw });
        run.decision(name, { args: toJson(args), ...payload });
      };
      let value: unknown;
      try {
        value = Reflect.apply(original, this, args);
      } catch (err) {
        record(true, { error: String(err) });
        throw err;
      }
      if (typeof (value as { then?: unknown } | null)?.then === "function") {
        // Not a decision of a pure core: what it decides is not known when the call returns.
        run.unsupported(
          `core function ${name} returned a promise; observed core functions must be synchronous and pure`,
        );
        return value;
      }
      record(false, { result: toJson(value) });
      return value;
    };
    let restore: () => void;
    try {
      restore = patchProperty(target, name, { get: () => wrapped });
    } catch (err) {
      unobservable[name] = `its module's namespace cannot be changed here (${String(err)})`;
      continue;
    }
    if (target[name] !== wrapped) {
      restore();
      unobservable[name] = "its module's namespace did not take the observer";
      continue;
    }
    undo.push(restore);
  }
  let restored = false;
  return {
    calls,
    unobservable,
    restore() {
      if (restored) return;
      restored = true;
      for (const u of undo.reverse()) u();
    },
  };
}
