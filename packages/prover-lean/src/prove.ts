/**
 * The engine: a module's functions through the subset reader, the emitter
 * and Lean, and each property's outcome back. One Lean run per module;
 * errors are mapped to theorems by line, so one failed proof does not hide
 * another. A proof that fails is `gave_up` (the engine is weak or the
 * claim is false; Lean does not say which), a function or property outside
 * the subset is `unsupported`, and no pinned toolchain is `unavailable`.
 * `total` is proved by Lean accepting the definition.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type {
  ModuleProofs,
  ProofOutcome,
  PropertyProof,
  Prover,
  ProveInput as ProverInput,
} from "@eutaxy/prover";
import {
  children,
  type Expr,
  listKinds,
  OutsideSubset,
  readSubset,
  restrictModule,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
} from "@eutaxy/prover/reader";
import type { FunctionSpec, Property, SpecError, SpecType } from "@eutaxy/spec";
import { type Emitted, emitModule } from "./emit.ts";
import { checkLean, findLean, type LeanDiagnostic, leanVersion } from "./lean.ts";
import {
  axiomsOf,
  provesExactly,
  readSupplied,
  type SuppliedProofs,
  standardAxioms,
} from "./supplied.ts";

export const engineName = "lean";

/** The types this engine translates: the integers, Bool, String and records of those. */
export const leanTakes = (t: SubsetType): boolean =>
  t.kind === "int" ||
  t.kind === "bool" ||
  t.kind === "string" ||
  t.kind === "record" ||
  (t.kind === "list" && leanTakes(t.element));

export type { ModuleProofs, ProofOutcome, PropertyProof } from "@eutaxy/prover";

export interface ProveInput extends ProverInput {
  /** Extra Lean lines appended after the theorems (translation checks). */
  readonly extra?: readonly string[];
}

/** This engine's report, with the Lean it checked. */
export interface LeanModuleProofs extends ModuleProofs {
  /** The Lean source checked, when any function was in the subset. */
  readonly lean?: string;
}

/** What every PROVEN verdict of this engine rests on. */
export const engineAssumptions: readonly string[] = [
  "number is modelled as the unbounded integers: no overflow, no fractions, no NaN",
  "string is modelled as Lean's String, a sequence of Unicode characters: a lone surrogate, which a JavaScript string can hold, is outside every string binder's domain",
  "the function and its callees are the module's own, pure and total; nothing outside the module is modelled",
  `the proof was checked by the Lean ${leanVersion} kernel on the emitted statement, not by Eutaxy`,
];

/** What a PROVEN over arrays rests on besides: the list model. */
export const listAssumption =
  "an array is modelled as a Lean List, dense: a sparse array, whose holes JavaScript's array methods skip, is outside every array binder's domain";

/** What a PROVEN that unfolds a recursive function rests on besides: that the JavaScript returns. */
export const recursionAssumption =
  "a recursive function is modelled as returning on every input: JavaScript's call stack is bounded, so on a long enough list the code throws (RangeError) where the model returns";

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

/** Every property of the functions, with one outcome. */
function allWith(fns: readonly FunctionSpec[], outcome: ProofOutcome): PropertyProof[] {
  return fns.flatMap((fn) =>
    fn.properties.map((property) => ({ function: fn.name, property: property.name, outcome })),
  );
}

/** The emitted Lean for the module's functions in the subset, and the functions with specs outside it with why. */
export interface Prepared {
  readonly module: SubsetModule;
  /** The proofs supplied beside the spec file, when there is a proof file. */
  readonly supplied?: SuppliedProofs;
  readonly emitted: Emitted;
  /** The functions to report on. */
  readonly fns: readonly FunctionSpec[];
  /** Those of them the subset does not take, with the reason. */
  readonly outside: ReadonlyMap<string, string>;
  /** Specs that did not read. */
  readonly specErrors: readonly SpecError[];
}

/**
 * Read and emit. Every function the subset takes is emitted (callees
 * included); properties are stated for the ones with specs among them.
 */
export function prepare(input: ProveInput): Prepared {
  const specs = input.specs;
  const wanted = input.functions ? new Set(input.functions) : undefined;
  const fns = specs.functions.filter((f) => !wanted || wanted.has(f.name));
  // Nullable types and tagged unions are read, but this engine does not take them yet: the SMT engine does.
  const module = restrictModule(
    readSubset(
      input.source,
      fns.map((f) => f.name),
      input.modulePath === undefined ? {} : { path: input.modulePath },
    ),
    leanTakes,
    "nullable types and tagged unions are not in the Lean engine's subset yet",
  );
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
  const properties: { function: string; property: Property }[] = fns
    .filter((fn) => !outside.has(fn.name))
    .flatMap((fn) =>
      fn.properties
        .filter((p) => p.kind === "forall")
        .map((property) => ({ function: fn.name, property })),
    );
  const specErrors = specs.errors;
  // Proofs supplied beside the spec file: `domain.props.lean` beside `domain.props.ts`.
  const proofFile = input.specPath?.replace(/\.ts$/, ".lean");
  const supplied =
    proofFile !== undefined && existsSync(proofFile)
      ? readSupplied(basename(proofFile), readFileSync(proofFile, "utf8"))
      : undefined;
  try {
    return {
      module,
      ...(supplied ? { supplied } : {}),
      emitted: emitModule(
        module,
        properties,
        input.extra,
        supplied && !supplied.refused ? supplied : undefined,
      ),
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

/**
 * A supplied proof's outcome: given up on when its lemmas or its tactics
 * do not compile, or when it rests on an axiom beyond Lean's standard
 * ones (`sorry` is one); PROVEN otherwise, saying it was supplied.
 */
function suppliedOutcome(
  file: string,
  error: LeanDiagnostic | undefined,
  axioms: readonly string[] | undefined,
  exact: boolean,
  assumptions: readonly string[],
): ProofOutcome {
  if (error)
    return unknown(
      "gave_up",
      `the proof supplied in ${file} does not close: ${error.message.split("\n")[0]}`,
    );
  if (!exact)
    return unknown(
      "gave_up",
      `the proof supplied in ${file} proves more hypotheses than its statement has (a section variable?), or Lean did not report its type`,
    );
  if (axioms === undefined)
    return unknown("gave_up", `Lean did not report the axioms of the proof supplied in ${file}`);
  const beyond = axioms.filter((a) => !standardAxioms.has(a));
  if (beyond.length > 0)
    return unknown(
      "gave_up",
      `the proof supplied in ${file} rests on ${beyond.join(", ")}, beyond Lean's standard axioms`,
    );
  return {
    ...proven,
    assumptions: [
      ...assumptions,
      `the proof was supplied in ${file}, not found by the engine's tactic script; Lean's kernel checked it against the statement Eutaxy emitted, and it rests on no axioms beyond propext, Classical.choice and Quot.sound`,
    ],
  };
}

/** Prove a module's properties with the pinned Lean. */
export async function proveModule(input: ProveInput): Promise<LeanModuleProofs> {
  const { module, emitted, fns, outside, specErrors, supplied } = prepare(input);
  const inSubset = fns.filter((f) => !outside.has(f.name));
  const unsupported = fns
    .filter((f) => outside.has(f.name))
    .flatMap((f) =>
      f.properties.map((property) => ({
        function: f.name,
        property: property.name,
        outcome: unknown("unsupported", outside.get(f.name) as string),
      })),
    );
  if (inSubset.length === 0) return { results: unsupported, specErrors };
  const lean = emitted.source;
  const rest = (outcome: ProofOutcome): LeanModuleProofs => ({
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
  const inLemmas = (d: LeanDiagnostic) =>
    emitted.lemmas !== undefined && d.line >= emitted.lemmas.from && d.line <= emitted.lemmas.to;
  const lemmaErrors = errors.filter(inLemmas);
  const elsewhere = errors.filter((d) => !inTheorem(d) && !inLemmas(d));
  if (elsewhere.length > 0) {
    // The emitted definitions themselves did not compile: an engine gap, never a verdict on the property.
    const where = elsewhere.map((d) => `line ${d.line}: ${d.message.split("\n")[0]}`).join("; ");
    return rest(unknown("unsupported", `the emitted Lean did not compile: ${where}`));
  }
  const results: PropertyProof[] = [...unsupported];
  for (const fn of inSubset) {
    for (const property of fn.properties) {
      if (property.kind === "total") {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: {
            ...proven,
            assumptions: [
              ...engineAssumptions,
              ...modelAssumptions(property, fn.name, module),
              "Lean accepted the definition, so it terminates on every input",
            ],
          },
        });
        continue;
      }
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
      if (supplied?.refused && supplied.proofs.has(property.name)) {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: unknown("gave_up", supplied.refused),
        });
        continue;
      }
      const theorem = emitted.theorems.find(
        (t) => t.function === fn.name && t.property === property.name,
      );
      const failed = theorem
        ? errors.filter((d) => d.line >= theorem.from && d.line <= theorem.to)
        : [];
      if (theorem?.supplied && supplied) {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: suppliedOutcome(
            supplied.file,
            lemmaErrors[0] ?? failed[0],
            axiomsOf(checked.diagnostics, theorem.axiomsLine ?? 0, theorem.name),
            provesExactly(checked.diagnostics, theorem.typeLine ?? 0, theorem.name),
            [...engineAssumptions, ...modelAssumptions(property, fn.name, module)],
          ),
        });
        continue;
      }
      results.push({
        function: fn.name,
        property: property.name,
        outcome:
          failed.length === 0
            ? {
                ...proven,
                assumptions: [...engineAssumptions, ...modelAssumptions(property, fn.name, module)],
              }
            : unknown(
                "gave_up",
                `Lean could not close the proof: ${(failed[0] as LeanDiagnostic).message.split("\n")[0]}`,
              ),
      });
    }
  }
  return { results, lean, specErrors };
}

/** The engine as a `Prover`: available when the pinned toolchain is installed. */
export const leanProver: Prover = {
  name: engineName,
  async available() {
    const toolchain = await findLean();
    return "unavailable" in toolchain ? toolchain : { version: toolchain.version };
  },
  prove: (input) => proveModule(input),
};

/** The list and recursion models a proof rests on, where its claim may meet them. */
function modelAssumptions(property: Property, fn: string, module: SubsetModule): string[] {
  // The module functions this claim's own arrows name, by the spec file's names for them: named at
  // all, called or not, so `(sum)(xs)` counts; a disclosure may err only toward saying more.
  const arrows = [property.when?.body ?? "", property.ensures?.body ?? ""].join("\n");
  const called = property.imports.filter((i) =>
    new RegExp(`(^|[^\\w$])${i.local.replace(/\$/g, "\\$")}($|[^\\w$])`).test(arrows),
  );
  const roots = [fn, ...called.map((i) => i.fn)];
  return [
    ...(usesLists(property, roots, module) ? [listAssumption] : []),
    ...(reached(roots, module).some((f) => f.structural !== undefined)
      ? [recursionAssumption]
      : []),
  ];
}

/**
 * The functions a property's claim may unfold: its function, the module
 * functions its arrows call, and, through their calls, everything they
 * reach.
 */
function reached(roots: readonly string[], module: SubsetModule): SubsetFunction[] {
  const byName = new Map(module.functions.map((f) => [f.name, f]));
  const out = new Map<string, SubsetFunction>();
  const visit = (name: string) => {
    const f = byName.get(name);
    if (!f || out.has(name)) return;
    out.set(name, f);
    const walk = (e: Expr): void => {
      if (e.kind === "call") visit(e.callee);
      for (const c of children(e)) walk(c);
    };
    walk(f.body);
  };
  for (const r of roots) visit(r);
  return [...out.values()];
}

/**
 * Whether a list can be in play in a property: a binder whose type holds
 * an array at any depth, or a function the claim may unfold that holds a
 * list in its types (through records too) or builds one.
 */
function usesLists(property: Property, roots: readonly string[], module: SubsetModule): boolean {
  const records = new Map(module.records.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const hasList = (t: SubsetType): boolean => {
    if (t.kind === "list") return true;
    if (t.kind === "nullable") return hasList(t.inner);
    if (t.kind === "record" && !seen.has(t.name)) {
      seen.add(t.name);
      return records.get(t.name)?.fields.some((f) => hasList(f.type)) ?? false;
    }
    return false;
  };
  const hasArray = (t: SpecType): boolean => {
    if (t.kind === "array") return true;
    if (t.kind === "union") return t.members.some(hasArray);
    if (t.kind === "record") return t.fields.some((f) => hasArray(f.type));
    return false;
  };
  const builds = (e: Expr): boolean => listKinds.has(e.kind) || children(e).some(builds);
  // The arrows' own array literals and methods, read from their text: a disclosure may err only toward saying more.
  const arrowLists = [property.when, property.ensures].some(
    (a) => a !== undefined && /\[|\.(map|flatMap|every|some|reduce|slice|length)\b/.test(a.body),
  );
  return (
    property.binders.some((b) => hasArray(b.type)) ||
    arrowLists ||
    reached(roots, module).some(
      (f) => hasList(f.returns) || f.params.some((p) => hasList(p.type)) || builds(f.body),
    )
  );
}
