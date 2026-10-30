/**
 * The engine: a module's functions through the subset reader, the emitter
 * and Z3, one script per property, and each property's outcome back. An
 * `unsat` is `PROVEN` under the engine's models of the language. A model
 * is a candidate counterexample, never a verdict: the engine runs the
 * spec file's own `when` and `ensures` on it, and only a claim that fails
 * on the real function is `REFUTED`, with the input shrunk as the TESTED
 * rung shrinks; a model the function does not confirm is a modelling gap,
 * `UNKNOWN` (`unsupported`) with the input. A resource limit reached is
 * `gave_up`; a function or property outside the subset is `unsupported`;
 * no pinned solver is `unavailable`.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  conforms,
  evaluate,
  type ModuleProofs,
  type ProofOutcome,
  type PropertyProof,
  type Prover,
  type ProveInput as ProverInput,
  render,
  shrinkRefutation,
} from "@eutaxy/prover";
import {
  listKinds,
  OutsideSubset,
  readSubset,
  restrictModule,
  type SubsetModule,
} from "@eutaxy/prover/reader";
import { type Fn, type Forall, type FunctionSpec, isSpec, type Property } from "@eutaxy/spec";
import {
  decode,
  equal,
  type PropertyScript,
  prelude,
  propertyScript,
  readAnswer,
  UnreadableModel,
} from "./emit.ts";
import { findZ3, solve, z3Version } from "./z3.ts";

export const engineName = "smt";

export interface ProveInput extends ProverInput {
  /** Extra Bool terms over the module's definitions that must hold (translation checks): each is checked unsatisfiable when negated. */
  readonly extra?: readonly string[];
  /** Z3's resource budget per property, in its own units. */
  readonly resourceLimit?: number;
}

/** This engine's report, with the definitions it ran. */
export interface SmtModuleProofs extends ModuleProofs {
  /** The prelude shared by every script, when any function was in the subset. */
  readonly smt?: string;
}

/** What every PROVEN verdict of this engine rests on. */
export const engineAssumptions: readonly string[] = [
  "number is modelled as the IEEE double (the floating-point theory): NaN, the infinities and -0 are in every binder's domain, and === is fp.eq",
  "string is modelled as a sequence of 16-bit code units, as JavaScript holds it",
  "the function and its callees are pure and total: the module's own, or generic or imported ones read at each call from their own files; nothing else is modelled",
  `Z3 ${z3Version} found the claim's negation unsatisfiable under a resource limit; no proof object was checked by a kernel`,
];

const proven: Extract<ProofOutcome, { kind: "PROVEN" }> = {
  kind: "PROVEN",
  engine: { name: engineName, version: z3Version },
  assumptions: engineAssumptions,
};

const unknown = (
  cause: "gave_up" | "unsupported" | "unavailable",
  reason: string,
): ProofOutcome => ({ kind: "UNKNOWN", cause, reason });

/** The scripts for the module's functions in the subset, and the functions with specs outside it with why. */
export interface Prepared {
  readonly module: SubsetModule;
  readonly fns: readonly FunctionSpec[];
  readonly outside: ReadonlyMap<string, string>;
  /** One script per statable forall property. */
  readonly scripts: ReadonlyMap<string, PropertyScript>;
  /** Properties the emitter could not state, with why. */
  readonly skipped: ReadonlyMap<string, string>;
  readonly prelude: string;
}

const key = (fn: string, property: string): string => `${fn}\u0000${property}`;

/** Read and emit: every function the subset takes, and a script per property of the ones with specs. */
export function prepare(input: ProveInput): Prepared {
  const wanted = input.functions ? new Set(input.functions) : undefined;
  const fns = input.specs.functions.filter((f) => !wanted || wanted.has(f.name));
  // Lists are read, but this engine does not take them: functions using one are outside here, so the
  // prelude never meets them and the module's other functions still go through.
  const module = restrictModule(
    readSubset(
      input.source,
      fns.map((f) => f.name),
      input.modulePath === undefined ? {} : { path: input.modulePath },
    ),
    (t) => t.kind !== "list" && t.kind !== "nothing",
    "arrays are not in this engine's subset (the Lean engine takes them)",
    listKinds,
  );
  const outside = new Map<string, string>();
  for (const o of module.outside)
    if (fns.some((f) => f.name === o.name))
      outside.set(
        o.name,
        `outside the engine's subset${o.line > 0 ? ` (line ${o.line})` : ""}: ${o.message}`,
      );
  for (const fn of fns) {
    const read = module.functions.find((f) => f.name === fn.name);
    if (read && read.offset !== fn.offset)
      outside.set(
        fn.name,
        `outside the engine's subset (line ${fn.line}): the ${fn.name} the spec names is not the module's top-level declaration of that name (line ${read.line})`,
      );
  }
  const scripts = new Map<string, PropertyScript>();
  const skipped = new Map<string, string>();
  let pre = "";
  try {
    pre = prelude(module);
    for (const fn of fns) {
      if (outside.has(fn.name)) continue;
      for (const property of fn.properties) {
        if (property.kind !== "forall") continue;
        try {
          scripts.set(key(fn.name, property.name), propertyScript(property, module));
        } catch (err) {
          if (!(err instanceof OutsideSubset)) throw err;
          skipped.set(key(fn.name, property.name), err.message);
        }
      }
    }
  } catch (err) {
    // The emitter refusing something the reader let through is an engine gap: every function is unsupported, none guessed.
    if (!(err instanceof OutsideSubset)) throw err;
    for (const fn of fns) outside.set(fn.name, `outside the engine's subset: ${err.message}`);
    scripts.clear();
  }
  return { module, fns, outside, scripts, skipped, prelude: pre };
}

/**
 * The spec file as a module. A relative import written without `.ts`
 * (`./domain`, `./domain.js`), which the simulator's loader resolves and
 * Node does not, is completed in a sibling copy that is imported and then
 * removed, so the copy's own relative imports still resolve.
 */
async function importSpecFile(specPath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(specPath).href)) as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw err;
    const source = readFileSync(specPath, "utf8");
    const dir = dirname(specPath);
    const rewritten = source.replace(
      /(from\s*["'])(\.{1,2}\/[^"']+?)(\.js)?(["'])/g,
      (whole, pre: string, rel: string, _js: string | undefined, post: string) =>
        existsSync(join(dir, `${rel}.ts`)) ? `${pre}${rel}.ts${post}` : whole,
    );
    if (rewritten === source) throw err;
    const copy = join(dir, `.eutaxy-replay-${process.pid}-${Date.now()}.props.ts`);
    writeFileSync(copy, rewritten);
    try {
      return (await import(pathToFileURL(copy).href)) as Record<string, unknown>;
    } finally {
      rmSync(copy, { force: true });
    }
  }
}

/** The spec file's export for a property, loaded for replay, or why it could not be. */
async function loadSpec(
  specPath: string | undefined,
  property: Property,
  fn: string,
): Promise<Forall<Fn> | string> {
  if (specPath === undefined)
    return "the engine was not given the spec file's path to replay the counterexample";
  let ns: Record<string, unknown>;
  try {
    ns = await importSpecFile(specPath);
  } catch (err) {
    return `the spec file could not be loaded to replay the counterexample: ${String(err)}`;
  }
  const exported = Object.hasOwn(ns, property.name) ? ns[property.name] : undefined;
  if (!isSpec(exported) || exported.kind !== "forall")
    return `the spec file exports no forall named ${property.name} to replay the counterexample with`;
  if (typeof exported.fn !== "function" || exported.fn.name !== fn)
    return `the spec file's ${property.name} is not on ${fn}`;
  return exported;
}

/** Prove a module's properties with the pinned Z3. */
export async function proveModule(input: ProveInput): Promise<SmtModuleProofs> {
  const { fns, outside, scripts, skipped, module, prelude: smt } = prepare(input);
  const specErrors = input.specs.errors;
  const inSubset = fns.filter((f) => !outside.has(f.name));
  const results: PropertyProof[] = fns
    .filter((f) => outside.has(f.name))
    .flatMap((f) =>
      f.properties.map((property) => ({
        function: f.name,
        property: property.name,
        outcome: unknown("unsupported", outside.get(f.name) as string),
      })),
    );
  if (inSubset.length === 0) return { results, specErrors };
  const allWith = (outcome: ProofOutcome): SmtModuleProofs => ({
    results: [
      ...results,
      ...inSubset.flatMap((fn) =>
        fn.properties.map((p) => ({ function: fn.name, property: p.name, outcome })),
      ),
    ],
    smt,
    specErrors,
  });
  const solver = await findZ3();
  if ("unavailable" in solver) return allWith(unknown("unavailable", solver.unavailable));
  const options = {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.resourceLimit === undefined ? {} : { resourceLimit: input.resourceLimit }),
  };
  // Translation checks first: a definition that does not compute what the TypeScript computes is an engine gap.
  if (input.extra && input.extra.length > 0) {
    const script = [
      smt,
      ...input.extra.flatMap((x) => ["(push)", `(assert (not ${x}))`, "(check-sat)", "(pop)"]),
      "",
    ].join("\n");
    const checked = await solve(solver, script, options);
    const answers = checked.run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(sat|unsat|unknown)$/.test(l));
    if (checked.run.timedOut)
      return allWith(unknown("gave_up", "Z3 did not finish the translation checks in time"));
    // The budget ran out on a check: nothing is known about the definitions, and nothing is claimed.
    if (answers.includes("unknown"))
      return allWith(unknown("gave_up", "Z3 reached its resource limit on a translation check"));
    const failed = answers.findIndex((a) => a !== "unsat");
    const errors = readAnswer(checked.run.stdout).errors;
    if (
      checked.run.code !== 0 ||
      errors.length > 0 ||
      answers.length !== input.extra.length ||
      failed >= 0
    )
      return allWith(
        unknown(
          "unsupported",
          `the emitted SMT failed a translation check${failed >= 0 ? ` (${input.extra[failed]})` : ""}: ${errors[0] ?? (checked.run.stderr || checked.run.stdout).trim().split("\n")[0] ?? ""}`,
        ),
      );
  }
  for (const fn of inSubset) {
    for (const property of fn.properties) {
      if (property.kind === "total") {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: unknown(
            "unsupported",
            "total is not decided by this engine (Lean proves it by acceptance)",
          ),
        });
        continue;
      }
      const k = key(fn.name, property.name);
      const why = skipped.get(k);
      if (why !== undefined) {
        results.push({
          function: fn.name,
          property: property.name,
          outcome: unknown("unsupported", why),
        });
        continue;
      }
      const script = scripts.get(k);
      if (!script) continue;
      const solved = await solve(solver, script.script, options);
      results.push({
        function: fn.name,
        property: property.name,
        outcome: await outcomeOf(solved, script, module, property, fn.name, input),
      });
    }
  }
  return { results, smt, specErrors };
}

async function outcomeOf(
  solved: Awaited<ReturnType<typeof solve>>,
  script: PropertyScript,
  module: SubsetModule,
  property: Property,
  fn: string,
  input: ProveInput,
): Promise<ProofOutcome> {
  if (solved.run.timedOut)
    return unknown("gave_up", `Z3 did not finish within ${input.timeoutMs ?? 120_000} ms`);
  if (solved.run.code === null)
    return unknown("unavailable", `Z3 could not be run: ${solved.run.stderr.trim()}`);
  const answer = readAnswer(solved.run.stdout);
  // An error Z3 printed means a command was dropped; whatever verdict line followed is not about the
  // claim. (The exit code says nothing here: Z3 exits non-zero for the model asked after `unsat` too.)
  if (answer.errors.length > 0)
    return unknown("unsupported", `the emitted SMT did not run: ${answer.errors[0]}`);
  if (answer.result === "unsat") return proven;
  if (answer.result === "unknown")
    return unknown(
      "gave_up",
      solved.resourceLimit
        ? `Z3 reached its resource limit${answer.reason ? ` (${answer.reason})` : ""}`
        : `Z3 gave up: ${answer.reason || "unknown"}`,
    );
  if (answer.result === "error")
    return unknown("unsupported", `the emitted SMT did not run: ${answer.reason}`);
  // sat: a candidate counterexample, replayed through the spec file's own claim.
  let values: unknown[];
  try {
    values = script.binders.map((b) => {
      const v = answer.values.get(b.symbol);
      if (v === undefined) throw new UnreadableModel(`no value for ${b.name} in the model`);
      return decode(v, b.type, module);
    });
  } catch (err) {
    if (!(err instanceof UnreadableModel)) throw err;
    return unknown("unsupported", `Z3's model could not be read: ${err.message}`);
  }
  const rendered = property.binders.map((b, i) => `${b.name} = ${render(values[i])}`).join(", ");
  // The solver saw the sorts; the claim quantifies over the TypeScript types, which may be narrower.
  if (!property.binders.every((b, i) => conforms(b.type, values[i])))
    return unknown(
      "unsupported",
      `Z3's model lies outside the parameter types (${rendered}): the engine's model of the types is wider than the types`,
    );
  const spec = await loadSpec(input.specPath, property, fn);
  if (typeof spec === "string") return unknown("unsupported", `${spec} (the model: ${rendered})`);
  const evaluation = evaluate(spec, values);
  if ("malformed" in evaluation)
    return unknown(
      "unsupported",
      `the property could not be evaluated on the model (${rendered}): ${evaluation.malformed}`,
    );
  if (evaluation.outcome !== "refuted")
    return unknown(
      "unsupported",
      `the claim ${evaluation.outcome === "held" ? "held" : "was outside its precondition"} on the model Z3 gave (${rendered}): the engine's model of the language differs from the runtime here`,
    );
  const smallest = shrinkRefutation(spec, property.binders, values, evaluation);
  return {
    kind: "REFUTED",
    engine: { name: engineName, version: z3Version },
    counterexample: {
      binders: property.binders.map((b, i) => ({
        name: b.name,
        value: render(smallest.values[i]),
      })),
      ...(smallest.error === undefined ? {} : { error: smallest.error }),
    },
    assumptions: [
      "found as a model of the claim's negation by Z3, confirmed by running the spec on it, then shrunk",
    ],
  };
}

/** The engine as a `Prover`: available when the pinned solver is installed. */
export const smtProver: Prover = {
  name: engineName,
  async available() {
    const solver = await findZ3();
    return "unavailable" in solver ? solver : { version: solver.version };
  },
  prove: (input) => proveModule(input),
};

export { equal };
