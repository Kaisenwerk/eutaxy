/**
 * Module-level constants, the module's own and imported ones, are read as
 * their values; Math.floor and division are read as JavaScript computes
 * them on doubles. The Lean engine, whose numbers are the integers, takes
 * Math.floor(x / c) for a positive integer constant c, and refuses other
 * division.
 */

import { MAX_ATTEMPTS, WINDOW_MS } from "./limits.ts";

const LAST_ATTEMPT = MAX_ATTEMPTS - 1;

/** The fixed window a time falls in. */
export function windowOf(nowMs: number): number {
  return Math.floor(nowMs / WINDOW_MS);
}

export const locked = (attempts: number): boolean => attempts > LAST_ATTEMPT;

export function floorOf(x: number): number {
  return Math.floor(x);
}

export function ratio(a: number, b: number): number {
  return a / b;
}
