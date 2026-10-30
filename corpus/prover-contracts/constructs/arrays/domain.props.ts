import { forall } from "@eutaxy/spec";
import { countOp, firstRepeat } from "./domain.ts";

export const atMostAll = forall(countOp, {
  ensures: (effects, op) => countOp(effects, op) <= effects.length,
});

export const splitsOverConcat = forall(countOp, {
  ensures: (effects, op) => countOp([...effects, ...effects], op) === 2 * countOp(effects, op),
});

// False: a list with a repeated key has one. Shrinks to two equal empty keys.
export const neverRepeats = forall(firstRepeat, {
  ensures: (keys) => firstRepeat(keys) === null,
});

export const repeatIsAKey = forall(firstRepeat, {
  ensures: (keys) => {
    const r = firstRepeat(keys);
    return r === null || keys.filter((k) => k === r).length >= 2;
  },
});
