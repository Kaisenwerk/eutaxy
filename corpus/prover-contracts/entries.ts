/**
 * The contract entries and their manifests, shared by the harness and the
 * coverage test. An entry is `constructs/<name>` (one construct of the
 * subset, or one refusal) or `shapes/<name>` (a realistic decision that
 * combines several); `constructs.json` is the vocabulary their `covers`
 * name.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const root = import.meta.dirname;

export type Expected = { readonly [fn: string]: { readonly [property: string]: string } };

export interface Manifest {
  readonly description: string;
  /** The constructs of `constructs.json` this entry exercises. */
  readonly covers: readonly string[];
  /** Per rung and engine: the TESTED rung on inputs drawn from the parameter types, then each engine. */
  readonly expect: { readonly tested: Expected; readonly lean: Expected; readonly smt: Expected };
  /**
   * Inputs, per function, each engine's translation must compute exactly
   * what JavaScript computes on, beyond the drawn ones: edge values with
   * where they come from (a test262 file, say). The Lean engine is checked
   * on those that are integers with an integer result, the numbers it
   * models. A number may be written "NaN", "-0", "Infinity" or
   * "-Infinity", which JSON cannot hold.
   */
  readonly edges?: {
    readonly [fn: string]: { readonly source: string; readonly inputs: readonly unknown[][] };
  };
}

const special: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  "-0": -0,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
};

/** An edge input as JavaScript sees it: the spelled numbers decoded. */
export const edgeValue = (v: unknown): unknown =>
  typeof v === "string" && v in special ? special[v] : v;

export type Engine = "lean" | "smt";

export interface Construct {
  /** What the construct is, in a line. */
  readonly what: string;
  /** Whether each engine takes it (`in`) or reports it `unsupported` (`out`). */
  readonly lean: "in" | "out";
  readonly smt: "in" | "out";
}

export const kinds = ["constructs", "shapes"] as const;

/** Every entry, as `constructs/<name>` or `shapes/<name>`, sorted within each kind. */
export const entries: readonly string[] = kinds.flatMap((kind) =>
  readdirSync(join(root, kind), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, kind, d.name, "manifest.json")))
    .map((d) => `${kind}/${d.name}`)
    .sort(),
);

export const manifest = (entry: string): Manifest =>
  JSON.parse(readFileSync(join(root, entry, "manifest.json"), "utf8")) as Manifest;

export const vocabulary = (): Readonly<Record<string, Construct>> =>
  (
    JSON.parse(readFileSync(join(root, "constructs.json"), "utf8")) as {
      constructs: Record<string, Construct>;
    }
  ).constructs;
