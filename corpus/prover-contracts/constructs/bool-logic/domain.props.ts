import { forall } from "@eutaxy/spec";
import { decide, either } from "./domain.ts";

export const allowedIff = forall(decide, {
  ensures: (admin, member, banned) =>
    decide(admin, member, banned).allowed === ((admin || member) && !banned),
});
export const reasonWhenBanned = forall(decide, {
  when: (_admin, _member, banned) => banned,
  ensures: (admin, member, banned) => decide(admin, member, banned).reason === 2,
});
export const reasonCodes = forall(decide, {
  ensures: (admin, member, banned) =>
    decide(admin, member, banned).reason >= 0 && decide(admin, member, banned).reason <= 2,
});
export const xor = forall(either, {
  ensures: (a, b) => either(a, b) === ((a && !b) || (!a && b)),
});
export const sameValue = forall(either, { ensures: (a, b) => either(a, b) === (a !== b) });
