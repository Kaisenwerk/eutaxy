/**
 * The scenario spec: everything Eutaxy needs to run one scenario, as plain
 * data. The platform-neutral parts are typed here; what a platform needs to
 * drive the Worker and set up its state travels as `PlatformData`, which only
 * that platform's package knows how to build and interpret.
 */

import type { JsonValue } from "./canonical-json.ts";
import type { Invariant } from "./invariants.ts";

/** Opaque, JSON-shaped data owned by a platform package. `kind` names its shape. */
export interface PlatformData {
  readonly kind: string;
  readonly [key: string]: JsonValue;
}

/** Where the Worker under test lives, relative to the scenario file. */
export interface WorkerRef {
  readonly entry: string;
  readonly config: string;
}

/** A scripted reply from an external: the first matching entry answers a request. */
export interface ScriptedResponse {
  /** HTTP method to match; any when absent. */
  readonly method?: string;
  /** URL path to match exactly, or a prefix when it ends with "*"; any when absent. */
  readonly path?: string;
  readonly status: number;
  readonly headers?: { readonly [name: string]: string };
  /** JSON body (sent as application/json) or a string body. */
  readonly body?: JsonValue;
}

/**
 * An external service the Worker talks to, what it promises, and how it
 * answers. Requests never reach the network: they are answered from
 * `responses`, and an undeclared host makes the run UNSUPPORTED.
 */
export interface ExternalDecl {
  readonly name: string;
  /** Host to match exactly, or a suffix pattern such as "*.example.com". */
  readonly host: string;
  readonly guarantees: {
    /**
     * Header whose value makes repeated requests idempotent: a request
     * repeating an earlier one's key gets the earlier response and is
     * recorded as not effective.
     */
    readonly dedupeBy?: string;
  };
  /** Omitted: every request gets 200 with an empty body. Present but unmatched: the run is UNSUPPORTED. */
  readonly responses?: readonly ScriptedResponse[];
}

/** Exploration bounds. Every verdict reports the bounds actually reached. */
export interface Bounds {
  readonly maxFaultsPerRun: number;
  readonly maxRedeliveries: number;
  readonly maxConcurrentInvocations: number;
  readonly budgetMs: number;
}

export interface ScenarioSpec {
  readonly version: 1;
  readonly name: string;
  /** Which platform package built and runs this scenario, e.g. "cloudflare" or "aws". Absent means cloudflare. */
  readonly platform?: string;
  readonly worker: WorkerRef;
  /** How the scenario drives the Worker (which events, with what payloads). */
  readonly drive: PlatformData;
  /** State to establish before each run, in order. */
  readonly setup: readonly PlatformData[];
  readonly externals: readonly ExternalDecl[];
  readonly invariants: readonly Invariant[];
  readonly bounds: Bounds;
  /**
   * Modules of pure core functions with Lemma specs, relative to the
   * scenario. Calls to their annotated functions are recorded as decisions
   * during exploration, and each property is checked on the inputs seen.
   */
  readonly specs?: readonly string[];
}

export const defaultBounds: Bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 2,
  maxConcurrentInvocations: 1,
  budgetMs: 2000,
};

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** Every reason a spec is not usable; empty when it is. */
export function validateScenario(spec: ScenarioSpec): readonly string[] {
  const errors: string[] = [];
  if (spec.version !== 1) errors.push(`version must be 1, got ${String(spec.version)}`);
  if (!spec.name.trim()) errors.push("name must not be empty");
  if (spec.platform !== undefined && !spec.platform)
    errors.push("platform must not be empty when given");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.name))
    errors.push(`name must be lowercase letters, digits and dashes: ${JSON.stringify(spec.name)}`);
  if (!spec.worker.entry) errors.push("worker.entry must not be empty");
  if (!spec.worker.config) errors.push("worker.config must not be empty");
  if (!spec.drive.kind) errors.push("drive.kind must not be empty");
  spec.setup.forEach((s, i) => {
    if (!s.kind) errors.push(`setup[${i}].kind must not be empty`);
  });
  if (spec.invariants.length === 0) errors.push("at least one invariant is required");
  const names = new Set<string>();
  for (const inv of spec.invariants) {
    if (!inv.name) errors.push("every invariant needs a name");
    else if (names.has(inv.name))
      errors.push(`duplicate invariant name ${JSON.stringify(inv.name)}`);
    names.add(inv.name);
  }
  const specs = new Set<string>();
  for (const m of spec.specs ?? []) {
    if (!m) errors.push("every specs entry needs a module path");
    else if (specs.has(m)) errors.push(`duplicate specs module ${JSON.stringify(m)}`);
    specs.add(m);
  }
  const ext = new Set<string>();
  for (const e of spec.externals) {
    if (!e.name) errors.push("every external needs a name");
    if (ext.has(e.name)) errors.push(`duplicate external ${JSON.stringify(e.name)}`);
    ext.add(e.name);
    if (!e.host) errors.push(`external ${JSON.stringify(e.name)} needs a host`);
    (e.responses ?? []).forEach((r, i) => {
      if (!(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)) {
        errors.push(
          `external ${JSON.stringify(e.name)} responses[${i}].status must be an HTTP status`,
        );
      }
    });
  }
  for (const k of ["maxFaultsPerRun", "maxRedeliveries"] as const) {
    const v = spec.bounds[k];
    if (!(Number.isInteger(v) && v >= 0)) errors.push(`bounds.${k} must be a non-negative integer`);
  }
  for (const k of ["maxConcurrentInvocations", "budgetMs"] as const) {
    if (!isPositiveInt(spec.bounds[k])) errors.push(`bounds.${k} must be a positive integer`);
  }
  return errors;
}
