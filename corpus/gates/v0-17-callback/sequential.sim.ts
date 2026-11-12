import { requests } from "./requests.sim.ts";

/** One invocation at a time, one fault a run: each object's work runs to rest before the next event. */
export default requests(1, 1);
