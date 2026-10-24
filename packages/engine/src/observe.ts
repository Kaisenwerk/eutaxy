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

import type { JsonValue } from "@eutaxy/core";
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

/** A JSON summary of a value for the log: exact for JSON, a readable string otherwise. */
export function summarize(value: unknown, depth = 0, seen = new Set<unknown>()): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : String(Object.is(value, -0) ? "-0" : value);
    case "bigint":
      return `${value}n`;
    case "function":
      return "[function]";
    case "symbol":
      return String(value);
  }
  if (depth > 8 || seen.has(value)) return "[…]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => summarize(v, depth + 1, seen));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return String(value);
    const out: { [k: string]: JsonValue } = {};
    // Defined, not assigned: an own `__proto__` key stays a key.
    for (const [k, v] of Object.entries(value as object))
      Object.defineProperty(out, k, {
        value: summarize(v, depth + 1, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  } finally {
    seen.delete(value);
  }
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
        run.decision(name, { args: summarize(args), ...payload });
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
      record(false, { result: summarize(value) });
      return value;
    };
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => wrapped,
      });
    } catch (err) {
      unobservable[name] = `its module's namespace cannot be changed here (${String(err)})`;
      continue;
    }
    if (target[name] !== wrapped) {
      unobservable[name] = "its module's namespace did not take the observer";
      continue;
    }
    undo.push(() => {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
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
