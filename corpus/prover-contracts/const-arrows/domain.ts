/**
 * Functions written as arrows that module-level consts hold, the way much
 * real code writes them: an expression body returning a record, a block
 * body with early returns, and calls between arrows and declarations.
 */

export interface Window {
  readonly index: number;
  readonly endsAt: number;
}

export const clampAttempts = (attempts: number, max: number): number => {
  if (attempts < 0) return 0;
  if (attempts > max) return max;
  return attempts;
};

export const nextWindow = (index: number, length: number): Window => ({
  index: index + 1,
  endsAt: (index + 2) * length,
});

export function remaining(attempts: number, max: number): number {
  return max - clampAttempts(attempts, max);
}
