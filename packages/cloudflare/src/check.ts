import {
  describeVerdict,
  type Platform,
  type ScenarioSpec,
  type ScenarioVerdict,
} from "@eutaxy/core";
import { type ExploreOptions, explore } from "@eutaxy/engine";

/** Explore a scenario on a platform and return its verdict. */
export function check(
  spec: ScenarioSpec,
  platform: Platform,
  options: ExploreOptions = { seed: spec.name },
): Promise<ScenarioVerdict> {
  return explore(spec, platform, options);
}

/** For use from a test: passes only when the scenario is BOUNDED. */
export async function expectHolds(
  spec: ScenarioSpec,
  platform: Platform,
  options?: ExploreOptions,
): Promise<void> {
  const verdict = await check(spec, platform, options);
  if (verdict.kind !== "BOUNDED") throw new Error(describeVerdict(verdict));
}
