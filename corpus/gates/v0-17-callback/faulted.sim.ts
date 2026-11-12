import { requests } from "./requests.sim.ts";

/** The same flow with one fault a run, anywhere: on a call out, a call back, a step. */
export default requests(2, 1);
