import { describe, expect, test } from "vitest";
import {
  compileFaultSites,
  describeFaultSites,
  type FaultSite,
  validateFaultSites,
} from "./fault-sites.ts";
import { writeFaults } from "./faults.ts";
import type { EffectSelector } from "./selectors.ts";

const insert = { target: "D1:DB", op: "run", args: { params: ["o-1"] }, allowed: writeFaults };

describe("compileFaultSites", () => {
  test("an invariant's selector serves as a site: its record kind is not the call's, and is ignored", () => {
    const completedInserts: EffectSelector = { target: "D1:DB", op: "run", kind: "result" };
    const site: FaultSite = completedInserts;
    expect(compileFaultSites([site])(insert)).toEqual(writeFaults);
  });

  test("without sites a point keeps every kind it allows", () => {
    expect(compileFaultSites(undefined)(insert)).toEqual(writeFaults);
  });

  test("a point no site matches takes no fault; one that matches takes the listed kinds it allows", () => {
    const sited = compileFaultSites([
      { target: "D1:DB", op: "run", faults: ["ambiguous", "cut_off"] },
    ]);
    expect(sited(insert)).toEqual(["ambiguous"]);
    expect(sited({ ...insert, op: "first" })).toEqual([]);
    expect(sited({ ...insert, target: "D1:OTHER" })).toEqual([]);
  });

  test("matching sites add up their kinds, in the point's own order; a site without kinds gives all", () => {
    const sited = compileFaultSites([
      { target: "D1:DB", faults: ["error"] },
      { target: "D1:DB", where: { "args.params.0": "o-1" }, faults: ["crash_before"] },
    ]);
    expect(sited(insert)).toEqual(["crash_before", "error"]);
    expect(sited({ ...insert, args: { params: ["o-2"] } })).toEqual(["error"]);
    expect(compileFaultSites([{ target: "D1:DB", atLeast: { "args.n": 2 } }])(insert)).toEqual([]);
    expect(
      compileFaultSites([{ target: "D1:DB", atLeast: { "args.n": 2 } }])({
        ...insert,
        args: { n: 3 },
      }),
    ).toEqual(writeFaults);
  });
});

test("validateFaultSites refuses a path a call's arguments cannot have", () => {
  expect(
    validateFaultSites([
      { target: "D1:DB", atLeast: { "result.changes": 1 } },
      { target: "Workflow:F", where: { step: "s", args: null, "args.step": "s" } },
    ]),
  ).toEqual([
    'bounds.faultsAt[0].atLeast: "result.changes" is not a path into the call\'s arguments; a site matches the call, so its paths start with "args."',
    'bounds.faultsAt[1].where: "step" is not a path into the call\'s arguments; a site matches the call, so its paths start with "args."',
  ]);
});

test("describeFaultSites names each site's kinds, target, op and conditions", () => {
  expect(
    describeFaultSites([
      { target: "Workflow:TURNS", where: { "args.step": "start turn" } },
      { target: "D1:DB", op: "run", atLeast: { "args.n": 2 }, faults: ["error", "ambiguous"] },
    ]),
  ).toBe(
    'faults only where the scenario\'s bounds say: any fault at Workflow:TURNS where {"args.step":"start turn"}; error or ambiguous at D1:DB run at least {"args.n":2}',
  );
});
