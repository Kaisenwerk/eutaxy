import { stepFaults } from "eutaxy/cloudflare";
import { turn } from "./scenario.sim.ts";

/** The step's three attempts each outlive their timeout, under twelve seeds for the late calls' orders. */
const lateAttempts = (binding: "CHAT" | "SAFE_CHAT") => {
  const base = turn(binding, false);
  return {
    ...base,
    name: `${base.name.replace(/-anywhere$/, "")}-pinned`,
    pinned: [
      {
        name: "every attempt of start turn outlives its timeout",
        faults: [1, 2, 3].map((attempt) => ({
          at: { ...stepFaults("TURNS", "start turn", { attempt }), op: "step" },
          fault: "ambiguous" as const,
        })),
        seeds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      },
    ],
  };
};

export default lateAttempts("CHAT");
/** The fixed object under the same pinned schedule. */
export const fixed = lateAttempts("SAFE_CHAT");
