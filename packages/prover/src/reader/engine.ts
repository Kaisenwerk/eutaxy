/**
 * A module as one first-party engine takes it: the functions to report on,
 * the subset read from the source and restricted to what the engine takes,
 * and the functions outside it with why. Every engine opens with this, so
 * what an engine translates has one reading to stand on, and a user reads
 * the same reason whichever engine gave it.
 */

import type { FunctionSpec } from "@eutaxy/spec";
import { type PropertyProof, type ProveInput, proofsOf, unknownOutcome } from "../provers.ts";
import { restrictModule } from "./restrict.ts";
import { readSubset } from "./subset.ts";
import type { Expr, SubsetModule, SubsetType } from "./tree.ts";

/** One thing an engine does not take, as `restrictModule` applies it. */
export interface EngineRestriction {
  /** The types the engine takes. */
  readonly takes: (t: SubsetType) => boolean;
  /** Why a function that falls to this restriction is outside. */
  readonly reason: string;
  /** Expression kinds a body may not hold: by default what nullable types and unions bring. */
  readonly bodies?: ReadonlySet<Expr["kind"]>;
  /** A body the engine refuses for what it computes, not its kinds or types (a division, say). */
  readonly refused?: (body: Expr) => boolean;
}

/** A module read for an engine. */
export interface EngineModule {
  /** The module as the engine sees it, its restrictions applied in order. */
  readonly module: SubsetModule;
  /** The functions to report on: the ones asked for among those with specs. */
  readonly fns: readonly FunctionSpec[];
  /** Those of them the engine does not take, with the reason; an engine adds what its emitter refuses (`engineGap`). */
  readonly outside: Map<string, string>;
}

/**
 * Read a module for an engine: the functions asked for (every one with
 * specs when none are named), the subset restricted by each of the
 * engine's restrictions in order, and the functions outside it, by the
 * reader's reason or because the spec names a declaration that is not the
 * module's top-level one of that name.
 */
export function readForEngine(
  input: Pick<ProveInput, "source" | "specs" | "functions" | "modulePath">,
  restrictions: readonly EngineRestriction[],
): EngineModule {
  const wanted = input.functions ? new Set(input.functions) : undefined;
  const fns = input.specs.functions.filter((f) => !wanted || wanted.has(f.name));
  let module = readSubset(
    input.source,
    fns.map((f) => f.name),
    input.modulePath === undefined ? {} : { path: input.modulePath },
  );
  for (const r of restrictions)
    module = restrictModule(module, r.takes, r.reason, r.bodies, r.refused);
  const outside = new Map<string, string>();
  for (const o of module.outside)
    if (fns.some((f) => f.name === o.name))
      outside.set(
        o.name,
        `outside the engine's subset${o.line > 0 ? ` (line ${o.line})` : ""}: ${o.message}`,
      );
  // A spec belongs to one declaration: the one the reader found at that offset. A nested function (in a
  // namespace, say) named like a top-level one must not lend its properties to the top-level body.
  for (const fn of fns) {
    const read = module.functions.find((f) => f.name === fn.name);
    if (read && read.offset !== fn.offset)
      outside.set(
        fn.name,
        `outside the engine's subset (line ${fn.line}): the ${fn.name} the spec names is not the module's top-level declaration of that name (line ${read.line})`,
      );
  }
  return { module, fns, outside };
}

/**
 * The emitter refused something the reader let through: an engine gap, so
 * every function is outside with that reason and none is guessed.
 */
export function engineGap(read: EngineModule, message: string): void {
  for (const fn of read.fns) read.outside.set(fn.name, `outside the engine's subset: ${message}`);
}

/** The outcomes of the functions outside the engine's subset: `unsupported`, each with its reason. */
export function outsideProofs(
  fns: readonly FunctionSpec[],
  outside: ReadonlyMap<string, string>,
): PropertyProof[] {
  return proofsOf(
    fns.filter((f) => outside.has(f.name)),
    (f) => unknownOutcome("unsupported", outside.get(f.name) as string),
  );
}
