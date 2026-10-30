/** Boolean parameters and results, with the connectives on both sides. */

export interface Access {
  readonly allowed: boolean;
  readonly reason: number;
}

export function decide(admin: boolean, member: boolean, banned: boolean): Access {
  if (banned) return { allowed: false, reason: 2 };
  if (admin || member) return { allowed: true, reason: 0 };
  return { allowed: false, reason: 1 };
}

export function either(a: boolean, b: boolean): boolean {
  return (a && !b) || (!a && b);
}
