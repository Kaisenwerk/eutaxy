/**
 * The engine: an annotated module's functions through the subset reader,
 * the emitter and Lean, and each property's outcome back. One Lean run per
 * module; errors are mapped to theorems by line, so one failed proof does
 * not hide another. A proof that fails is `gave_up` (the engine is weak or
 * the claim is false; Lean does not say which), a function or property
 * outside the subset is `unsupported`, and no pinned toolchain is
 * `unavailable`. `@total` is proved by Lean accepting the definition.
 */

import { extractSpecs, type FunctionSpec, type ModuleSpecs, type SpecError } from "@eutaxy/spec";
import { type Emitted, emitModule } from "./emit.ts";
import { checkLean, findLean, type LeanDiagnostic, leanVersion } from "./lean.ts";
import { OutsideSubset, readSubset, type SubsetModule } from "./subset.ts";

export const engineName = "lean";

export type ProofOutcome =
  | {
      readonly kind: "PROVEN";
      readonly engine: { readonly name: string; readonly version: string };
      readonly assumptions: readonly string[];
    }
  | {
      readonly kind: "UNKNOWN";
      readonly cause: "gave_up" | "unsupported" | "unavailable";
      readonly reason: string;
    };

export interface PropertyProof {
  readonly function: string;
  /** The `@ensures` name, or `@total`. */
  readonly property: string;
  readonly outcome: ProofOutcome;
}

export interface ModuleProofs {
  readonly results: readonly PropertyProof[];
  /** The Lean source checked, when the module was in the subset. */
  readonly lean?: string;
  /** Annotations that did not parse, with their lines: properties that were asked for and never checked. */
  readonly specErrors: readonly SpecError[];
}

export interface ProveInput {
  readonly source: string;
  /** The annotated functions to prove; every annotated one when omitted. */
  readonly functions?: readonly string[];
  readonly timeoutMs?: number;
  /** Extra Lean lines appended after the theorems (translation checks). */
  readonly extra?: readonly string[];
  /** Already extracted specs of the source, when the caller has them. */
  readonly specs?: ModuleSpecs;
}

/** What every PROVEN verdict of this engine rests on. */
export const engineAssumptions: readonly string[] = [
  "number is modelled as the unbounded integers: no overflow, no fractions, no NaN",
  "the function and its callees are the module's own, pure and total; nothing outside the module is modelled",
  `the proof was checked by the Lean ${leanVersion} kernel on the emitted statement, not by Eutaxy`,
];

const proven: Extract<ProofOutcome, { kind: "PROVEN" }> = {
  kind: "PROVEN",
  engine: { name: engineName, version: leanVersion },
  assumptions: engineAssumptions,
};

const unknown = (
  cause: "gave_up" | "unsupported" | "unavailable",
  reason: string,
): ProofOutcome => ({
  kind: "UNKNOWN",
  cause,
  reason,
});

function propertiesOf(fn: FunctionSpec): string[] {
  return [...fn.ensures.map((p) => p.name), ...(fn.total ? ["@total"] : [])];
}

/** Every property of the functions, with one outcome. */
function allWith(fns: readonly FunctionSpec[], outcome: ProofOutcome): PropertyProof[] {
  return fns.flatMap((fn) =>
    propertiesOf(fn).map((property) => ({ function: fn.name, property, outcome })),
  );
}

/** The emitted Lean for the module's functions in the subset, and the annotated functions outside it with why. */
export interface Prepared {
  readonly module: SubsetModule;
  readonly emitted: Emitted;
  /** The annotated functions to report on. */
  readonly fns: readonly FunctionSpec[];
  /** Those of them the subset does not take, with the reason. */
  readonly outside: ReadonlyMap<string, string>;
  /** Annotations that did not parse. */
  readonly specErrors: readonly SpecError[];
}

/**
 * Read and emit. Every function the subset takes is emitted (callees
 * included); properties are stated for the annotated ones among them.
 */
export function prepare(input: ProveInput): Prepared {
  const specs = input.specs ?? extractSpecs(input.source);
  const wanted = input.functions ? new Set(input.functions) : undefined;
  const fns = specs.functions.filter((f) => !wanted || wanted.has(f.name));
  const module = readSubset(
    input.source,
    fns.map((f) => f.name),
  );
  const outside = new Map<string, string>();
  for (const o of module.outside)
    if (fns.some((f) => f.name === o.name))
      outside.set(
        o.name,
        `outside the engine's subset${o.line > 0 ? ` (line ${o.line})` : ""}: ${o.message}`,
      );
  // An annotation belongs to one declaration: the one on its line. A nested function (in a namespace,
  // say) named like a top-level one must not lend its properties to the top-level body.
  for (const fn of fns) {
    const read = module.functions.find((f) => f.name === fn.name);
    if (read && read.offset !== fn.offset)
      outside.set(
        fn.name,
        `outside the engine's subset (line ${fn.line}): the annotated ${fn.name} is not the module's top-level declaration of that name (line ${read.line})`,
      );
  }
  const properties = fns
    .filter((fn) => !outside.has(fn.name))
    .flatMap((fn) => fn.ensures.map((property) => ({ function: fn.name, property })));
  const specErrors = specs.errors;
  try {
    return {
      module,
      emitted: emitModule(module, properties, input.extra),
      fns,
      outside,
      specErrors,
    };
  } catch (err) {
    // The emitter refusing something the reader let through is an engine gap: every function is unsupported, none guessed.
    if (!(err instanceof OutsideSubset)) throw err;
    for (const fn of fns) outside.set(fn.name, `outside the engine's subset: ${err.message}`);
    const empty: Emitted = { source: "", theorems: [], skipped: [] };
    return { module, emitted: empty, fns, outside, specErrors };
  }
}

/** Prove a module's properties with the pinned Lean. */
export async function proveModule(input: ProveInput): Promise<ModuleProofs> {
  const { emitted, fns, outside, specErrors } = prepare(input);
  const inSubset = fns.filter((f) => !outside.has(f.name));
  const unsupported = fns
    .filter((f) => outside.has(f.name))
    .flatMap((f) =>
      propertiesOf(f).map((property) => ({
        function: f.name,
        property,
        outcome: unknown("unsupported", outside.get(f.name) as string),
      })),
    );
  if (inSubset.length === 0) return { results: unsupported, specErrors };
  const lean = emitted.source;
  const rest = (outcome: ProofOutcome): ModuleProofs => ({
    results: [...unsupported, ...allWith(inSubset, outcome)],
    lean,
    specErrors,
  });
  const toolchain = await findLean();
  if ("unavailable" in toolchain) return rest(unknown("unavailable", toolchain.unavailable));
  const timeoutMs = input.timeoutMs ?? 120_000;
  const checked = await checkLean(toolchain, lean, { timeoutMs });
  if (checked.run.timedOut)
    return rest(unknown("gave_up", `Lean did not finish within ${timeoutMs} ms`));
  const errors = checked.diagnostics.filter((d) => d.severity === "error");
  const inTheorem = (d: LeanDiagnostic) =>
    emitted.theorems.find((t) => d.line >= t.from && d.line <= t.to);
  if (checked.run.code === null || (checked.run.code !== 0 && errors.length === 0))
    return rest(
      unknown(
        "unavailable",
        `Lean could not be run: ${checked.run.stderr.trim() || `exit ${checked.run.code}`}`,
      ),
    );
  const elsewhere = errors.filter((d) => !inTheorem(d));
  if (elsewhere.length > 0) {
    // The emitted definitions themselves did not compile: an engine gap, never a verdict on the property.
    const where = elsewhere.map((d) => `line ${d.line}: ${d.message.split("\n")[0]}`).join("; ");
    return rest(unknown("unsupported", `the emitted Lean did not compile: ${where}`));
  }
  const results: PropertyProof[] = [...unsupported];
  for (const fn of inSubset) {
    for (const property of fn.ensures) {
      const skipped = emitted.skipped.find(
        (s) => s.function === fn.name && s.property === property.name,
      );
      if (skipped) {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: unknown("unsupported", skipped.reason),
        });
        continue;
      }
      const theorem = emitted.theorems.find(
        (t) => t.function === fn.name && t.property === property.name,
      );
      const failed = theorem
        ? errors.filter((d) => d.line >= theorem.from && d.line <= theorem.to)
        : [];
      results.push({
        function: fn.name,
        property: property.name,
        outcome:
          failed.length === 0
            ? proven
            : unknown(
                "gave_up",
                `Lean could not close the proof: ${(failed[0] as LeanDiagnostic).message.split("\n")[0]}`,
              ),
      });
    }
    if (fn.total)
      results.push({
        function: fn.name,
        property: "@total",
        outcome: {
          ...proven,
          assumptions: [
            ...engineAssumptions,
            "Lean accepted the definition, so it terminates on every input",
          ],
        },
      });
  }
  return { results, lean, specErrors };
}
