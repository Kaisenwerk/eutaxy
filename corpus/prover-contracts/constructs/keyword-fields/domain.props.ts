import { forall } from "@eutaxy/spec";
import { span } from "./domain.ts";

export const ordered = forall(span, {
  when: (_from, len) => Number.isInteger(len) && 0 <= len,
  ensures: (from, len) => span(from, len).end >= span(from, len).from,
});
export const length = forall(span, {
  when: (_from, len) => Number.isInteger(len) && 0 <= len,
  ensures: (from, len) => span(from, len).end - span(from, len).from === len,
});
