import { forall } from "@eutaxy/spec";
import { admit, bump, decideAccess } from "./domain.ts";

export const bumpCounts = forall(bump, { ensures: (c) => bump(c).attempts === c.attempts + 1 });
export const lockedAtFive = forall(bump, {
  when: (c) => c.attempts >= 4,
  ensures: (c) => bump(c).locked,
});
export const admitsMatches = forall(admit, {
  when: (c) => c !== null && !c.locked,
  ensures: (c, matches) => admit(c, matches).ok === matches,
});
export const nullRefused = forall(admit, {
  when: (c) => c === null,
  ensures: (c, matches) => !admit(c, matches).ok,
});
export const sendCodeIff = forall(decideAccess, {
  ensures: (status) =>
    (decideAccess(status) === "send_code") === (status === "invited" || status === "active"),
});
// Planted false claim: a locked challenge is refused whatever the guess matches.
export const admitsWhenNotNull = forall(admit, {
  when: (c) => c !== null,
  ensures: (c, matches) => admit(c, matches).ok === matches,
});
