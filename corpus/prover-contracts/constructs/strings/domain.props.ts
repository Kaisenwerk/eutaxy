import { forall, total } from "@eutaxy/spec";
import { decideAccess, label, networkKey, sameNetwork, tag } from "./domain.ts";

export const sendCodeIff = forall(decideAccess, {
  ensures: (status) =>
    (decideAccess(status) === "send_code") === (status === "invited" || status === "active"),
});
export const twoOutcomes = forall(decideAccess, {
  ensures: (status) => decideAccess(status) === "send_code" || decideAccess(status) === "waitlist",
});
export const decideAccessTotal = total(decideAccess);
export const neverEmpty = forall(networkKey, { ensures: (address) => networkKey(address) !== "" });
export const distinctNetworks = forall(sameNetwork, {
  ensures: (a, b) => sameNetwork(a, b) === (a === b),
});
export const kindOfSign = forall(tag, {
  ensures: (n) => (n >= 0 || tag(n).kind === "neg") && (n < 0 || tag(n).kind === "pos"),
});
export const codeKept = forall(tag, { ensures: (n) => tag(n).code === n });
export const escapes = forall(label, { ensures: (n) => label(n) !== 'a"b\\c\n' || n === 0 });
