import { requests } from "./requests.sim.ts";

/** The same flow against the front Worker that records every notice it is sent. */
export default requests(1, 1, false, "./worker.planted.ts");
