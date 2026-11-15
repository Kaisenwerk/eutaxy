/**
 * Fault sites: where a scenario's bounds let faults go. A run spends its
 * faults only at effect points a site matches, and only of the kinds the
 * matching sites list, so a bug that needs faults at a few chosen points
 * (every attempt of one step) is not left to the odds of sampling among
 * every point a run has.
 */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { FaultKind } from "./faults.ts";
import { compileSelector } from "./selectors.ts";

/**
 * Effect points a fault may hit, matched on the effect's call as an
 * `EffectSelector` matches a record: `target` exactly, `op` when given,
 * `where` and `atLeast` on dot paths into `{ args }`. `faults` narrows the
 * kinds to those listed (each point still allows only its own); absent,
 * every kind the point allows. An invariant's selector serves as a site
 * when its paths are into `args`: its record `kind` is ignored, since a
 * site always matches the call.
 */
export interface FaultSite {
  readonly target: string;
  readonly op?: string;
  readonly where?: { readonly [path: string]: JsonValue };
  readonly atLeast?: { readonly [path: string]: number };
  readonly faults?: readonly FaultKind[];
}

/** Every fault kind, in the order the fault model lists them. */
export const faultKinds: readonly FaultKind[] = [
  "crash_before",
  "crash_after",
  "ambiguous",
  "error",
  "cut_off",
];

/** Every reason the sites are not usable, under `bounds.faultsAt`; empty when they are. */
export function validateFaultSites(sites: readonly FaultSite[]): readonly string[] {
  if (sites.length === 0)
    return ["bounds.faultsAt must name at least one site; leave it out for faults anywhere"];
  return sites.flatMap((site, i) => siteErrors(site, `bounds.faultsAt[${i}]`));
}

/** Every reason one site is not usable, each message starting with `label`, where it sits in the scenario. */
export function siteErrors(site: FaultSite, label: string): readonly string[] {
  const errors: string[] = [];
  if (!site.target) errors.push(`${label} needs a target`);
  for (const field of ["where", "atLeast"] as const)
    for (const path of Object.keys(site[field] ?? {}))
      if (path !== "args" && !path.startsWith("args."))
        errors.push(
          `${label}.${field}: ${JSON.stringify(path)} is not a path into the call's arguments; a site matches the call, so its paths start with "args."`,
        );
  if (site.faults === undefined) return errors;
  if (site.faults.length === 0)
    errors.push(`${label}.faults must name at least one fault kind; leave it out for every kind`);
  for (const f of site.faults)
    if (!faultKinds.includes(f))
      errors.push(
        `${label}.faults: ${JSON.stringify(f)} is not a fault kind (${faultKinds.join(", ")})`,
      );
  return errors;
}

/** What an effect point offers a fault: its call and the kinds it allows. */
export interface FaultSitePoint {
  readonly target: string;
  readonly op: string;
  readonly args: JsonValue;
  readonly allowed: readonly FaultKind[];
}

/**
 * The sites prepared once: for a point, the kinds it allows that some
 * matching site lists, in the point's own order; none when no site matches.
 * Without sites, a point keeps every kind it allows.
 */
export function compileFaultSites(
  sites: readonly FaultSite[] | undefined,
): (point: FaultSitePoint) => readonly FaultKind[] {
  if (sites === undefined) return (point) => point.allowed;
  // Only a site's own fields: a selector's record kind would never match the call.
  const compiled = sites.map(({ target, op, where, atLeast, faults }) => ({
    matches: compileSelector({
      target,
      ...(op === undefined ? {} : { op }),
      ...(where === undefined ? {} : { where }),
      ...(atLeast === undefined ? {} : { atLeast }),
    }),
    faults,
  }));
  return (point) => {
    const record = {
      seq: 0,
      kind: "call" as const,
      invocation: "",
      target: point.target,
      op: point.op,
      payload: { args: point.args },
    };
    const kinds = new Set<FaultKind>();
    for (const { matches, faults } of compiled) {
      if (!matches(record)) continue;
      for (const f of faults ?? point.allowed) kinds.add(f);
    }
    return point.allowed.filter((f) => kinds.has(f));
  };
}

/** One line for a verdict's assumptions: which faults the sites let through, and where. */
export function describeFaultSites(sites: readonly FaultSite[]): string {
  const one = (s: FaultSite): string => {
    const kinds = s.faults === undefined ? "any fault" : s.faults.join(" or ");
    const where = s.where === undefined ? "" : ` where ${canonicalJson(s.where)}`;
    const atLeast = s.atLeast === undefined ? "" : ` at least ${canonicalJson(s.atLeast)}`;
    return `${kinds} at ${s.target}${s.op === undefined ? "" : ` ${s.op}`}${where}${atLeast}`;
  };
  return `faults only where the scenario's bounds say: ${sites.map(one).join("; ")}`;
}
