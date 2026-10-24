import scenario from "./scenario.sim.ts";

// The same refunds one at a time: the shell follows the core, and the second refund
// reaches the core with 600 already refunded, the input its off-by-one gets wrong.
export default { ...scenario, bounds: { ...scenario.bounds, maxConcurrentInvocations: 1 } };
