/** One function uses a loop, so the engine refuses it, and only it: the other is proved. */

export function sumTo(n: number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) total += i;
  return total;
}

export function same(x: number): number {
  return x;
}
