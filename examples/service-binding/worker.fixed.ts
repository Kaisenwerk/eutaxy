/**
 * The same checkout, made safe to resend: the key is derived from the
 * order, so a resend after a lost answer carries the key of the first
 * attempt and the payments Worker hands that charge back.
 * `eutaxy check ./checkout.fixed.sim.ts` reports BOUNDED.
 */

import { checkout } from "./worker.ts";

export default checkout((orderId) => `order:${orderId}`);
