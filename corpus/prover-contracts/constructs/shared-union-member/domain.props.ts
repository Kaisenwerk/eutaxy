import { forall } from "@eutaxy/spec";
import { admit, room } from "./domain.ts";

export const fullPassesThrough = forall(room, {
  when: (l, c) => Number.isInteger(l) && Number.isInteger(c),
  ensures: (l, c) => {
    const r = room(l, c);
    if (r.ok) return r.value >= 0;
    return (r.error.kind === "full") === (l > 0 && l > c);
  },
});
export const admitsWithin = forall(admit, {
  when: (l, c) => Number.isInteger(l) && Number.isInteger(c),
  ensures: (l, c) => admit(l, c).ok === (l > 0 && l <= c),
});
// Planted false claim: an empty load is refused.
export const alwaysRoom = forall(room, { ensures: (l, c) => room(l, c).ok });
