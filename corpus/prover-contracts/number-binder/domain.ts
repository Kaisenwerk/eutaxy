/** number binders are proved under the integer model; a regex precondition is outside the engine. */

export function abs(x: number): number {
  return x < 0 ? -x : x;
}

export function shout(s: string): string {
  // biome-ignore lint/style/useTemplate: joining with + is in the subset; template literals are not
  return s + "!";
}
