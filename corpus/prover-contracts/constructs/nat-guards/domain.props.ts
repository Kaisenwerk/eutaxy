import { forall } from "@eutaxy/spec";
import { twice, withdraw } from "./domain.ts";

export const neverNegative = forall(withdraw, {
  when: (balance, amount) => 0 <= balance && 0 <= amount && amount <= 1_000,
  ensures: (balance, amount) => withdraw(balance, amount) >= 0,
});
export const atMostBalance = forall(withdraw, {
  when: (balance) => 0 <= balance,
  ensures: (balance, amount) => withdraw(balance, amount) <= balance,
});
export const exactWhenAffordable = forall(withdraw, {
  when: (balance, amount) => 0 <= balance && 0 <= amount && amount <= balance,
  ensures: (balance, amount) => withdraw(balance, amount) === balance - amount,
});
export const smallDouble = forall(twice, {
  when: (n) => 0 < n && n < 50,
  ensures: (n) => twice(n) < 100,
});
