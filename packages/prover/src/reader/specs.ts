/**
 * A module and its spec file read into `ModuleSpecs` through the
 * compiler. From the module: the exported functions and their parameter
 * types (`function` declarations and `const` arrows alike), the types as
 * the compiler resolves them. From the spec file: every
 * `export const name = forall(f, { sample, when, ensures })` and
 * `total(f)`, with the combinators imported from `eutaxy/spec` and `f`
 * imported from the module beside the spec file (the import resolved by
 * the compiler); the arrows are kept as text, their parameter names
 * naming the binders, and the precondition's conjuncts about one
 * parameter become that binder's hint. Anything else is an error with a
 * line, never a guess.
 */

import type {
  Arrow,
  Binder,
  Endpoint,
  FunctionSpec,
  Hint,
  ModuleSpecs,
  Param,
  Property,
  SpecError,
  SpecType,
} from "@eutaxy/spec";
import {
  type ArrowFunction,
  type Expression,
  type FunctionLikeBase,
  type ImportDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import type { Checker, Program } from "typescript/sync";
import { endpointBigInt, endpointNumber } from "../generate.ts";
import {
  isAsync,
  isConst,
  isExported,
  lineAt,
  openParen,
  textOf,
  withProgram,
  withSourceFile,
} from "./compiler.ts";
import { specTypeOf, unionOf } from "./types.ts";

export interface ReadSpecsInput {
  /** The module's source. */
  readonly module: string;
  /** The spec file's source. */
  readonly spec: string;
  /**
   * The module's path, under which its imports resolve; the spec file
   * is beside it unless `specPath` says otherwise. For a module given
   * by text alone, any absolute path the spec file's import of the
   * module resolves to (`/x/domain.ts` for `import … from "./domain.ts"`).
   */
  readonly modulePath: string;
  /** The spec file's path; `<module>.props.ts` by default. */
  readonly specPath?: string;
  /** Specifiers the combinators come from; `eutaxy/spec` and the workspace name by default. */
  readonly specSpecifiers?: readonly string[];
}

// ---------------------------------------------------------------------------
// The module: exported functions and their parameter types.

interface Declaration {
  readonly name: string;
  readonly params: readonly Param[];
  readonly line: number;
  readonly offset: number;
}

interface ModuleSide {
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** Exported name to local declaration name. */
  readonly exports: ReadonlyMap<string, string>;
  readonly errors: readonly SpecError[];
}

/** The parameters of a function-like declaration: `name?: T = default`, `...rest`, destructured. */
function readParams(checker: Checker, fn: FunctionLikeBase): Param[] {
  const params: Param[] = [];
  for (const p of fn.parameters) {
    const name = is.isIdentifier(p.name) ? p.name.text : null;
    if (name === "this") continue; // a receiver annotation, no argument
    if (p.dotDotDotToken) {
      params.push({ name: null, type: { kind: "unknown", text: `...${name ?? ""}` } });
      continue;
    }
    let type: SpecType;
    if (p.type) type = specTypeOf(checker, checker.getTypeAtLocation(p.type));
    else if (p.initializer) type = specTypeOf(checker, checker.getTypeAtLocation(p));
    else type = { kind: "unknown", text: "(no type annotation)" };
    // An optional parameter, or one with a default, may be passed undefined.
    if (p.questionToken || p.initializer) type = unionOf([type, { kind: "undefined" }]);
    params.push({ name, type });
  }
  return params;
}

function readModuleSide(sf: SourceFile, checker: Checker): ModuleSide {
  const errors: SpecError[] = [];
  const declarations = new Map<string, Declaration>();
  const exports = new Map<string, string>();
  const declare = (name: string, fn: FunctionLikeBase, at: Node): void => {
    const offset = openParen(sf, fn);
    if (offset === undefined) return; // an arrow without parentheses: no parameter list to point at
    if (declarations.has(name)) {
      errors.push({
        line: lineAt(sf, at),
        message: `${name} is declared more than once (overloads): a spec is checked against one signature`,
        inModule: true,
      });
      return;
    }
    declarations.set(name, { name, params: readParams(checker, fn), line: lineAt(sf, at), offset });
  };
  for (const st of sf.statements) {
    if (is.isFunctionDeclaration(st)) {
      if (!st.name) continue;
      declare(st.name.text, st, st);
      if (isExported(st)) exports.set(st.name.text, st.name.text);
      continue;
    }
    if (is.isVariableStatement(st)) {
      // `export const f = (a: T): R => …` or `= function (a: T) …`: a function by another declaration.
      for (const d of st.declarationList.declarations) {
        if (!is.isIdentifier(d.name) || !d.initializer) continue;
        let init: Expression = d.initializer;
        while (is.isParenthesizedExpression(init)) init = init.expression;
        if (!is.isArrowFunction(init) && !is.isFunctionExpression(init)) continue;
        declare(d.name.text, init, st);
        if (isExported(st)) exports.set(d.name.text, d.name.text);
      }
      continue;
    }
    // `export { a, b as c }`; with `from`, a re-export of another module's names (not this module's).
    if (is.isExportDeclaration(st) && !st.moduleSpecifier && !st.isTypeOnly && st.exportClause) {
      if (!is.isNamedExports(st.exportClause)) continue;
      for (const e of st.exportClause.elements) {
        if (e.isTypeOnly) continue;
        const local = e.propertyName ?? e.name;
        if (is.isIdentifier(local) && is.isIdentifier(e.name)) exports.set(e.name.text, local.text);
      }
    }
  }
  return { declarations, exports, errors };
}

// ---------------------------------------------------------------------------
// The spec file.

interface Imported {
  readonly from: string;
  /** The exported name imported; `*` for a namespace import. */
  readonly name: string;
  readonly declaration: ImportDeclaration;
}

/** `import { a, b as c } from "x"`, `import * as ns from "x"`, `import d from "x"`; type-only imports skipped. */
function imports(sf: SourceFile): Map<string, Imported> {
  const out = new Map<string, Imported>();
  for (const st of sf.statements) {
    if (!is.isImportDeclaration(st) || !st.importClause) continue;
    const clause = st.importClause;
    if (clause.phaseModifier === SyntaxKind.TypeKeyword) continue;
    if (!is.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    if (clause.name) out.set(clause.name.text, { from, name: "default", declaration: st });
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (is.isNamespaceImport(bindings))
      out.set(bindings.name.text, { from, name: "*", declaration: st });
    else
      for (const e of bindings.elements) {
        if (e.isTypeOnly) continue;
        const imported = e.propertyName ?? e.name;
        const name = is.isIdentifier(imported) ? imported.text : imported.text;
        out.set(e.name.text, { from, name, declaration: st });
      }
  }
  return out;
}

/** `1`, `-1`, `1_000`, `1.5`, `10n` as an endpoint value; undefined otherwise. */
function numberText(sf: SourceFile, node: Expression): string | undefined {
  if (is.isNumericLiteral(node) || is.isBigIntLiteral(node))
    return textOf(sf, node).replace(/_/g, "");
  if (
    is.isPrefixUnaryExpression(node) &&
    node.operator === SyntaxKind.MinusToken &&
    (is.isNumericLiteral(node.operand) || is.isBigIntLiteral(node.operand))
  )
    return `-${textOf(sf, node.operand).replace(/_/g, "")}`;
  return undefined;
}

/** The top-level conjuncts of an expression, parentheses stripped. */
function conjuncts(node: Expression, out: Expression[] = []): Expression[] {
  let e = node;
  while (is.isParenthesizedExpression(e)) e = e.expression;
  if (is.isBinaryExpression(e) && e.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken) {
    conjuncts(e.left, out);
    conjuncts(e.right, out);
  } else out.push(e);
  return out;
}

const comparisons: Partial<Record<SyntaxKind, string>> = {
  [SyntaxKind.LessThanToken]: "<",
  [SyntaxKind.LessThanEqualsToken]: "<=",
  [SyntaxKind.GreaterThanToken]: ">",
  [SyntaxKind.GreaterThanEqualsToken]: ">=",
};

/**
 * What an expression says about each of the named parameters on its own:
 * its top-level conjuncts of the forms `Number.isInteger(x)`, `x < n`,
 * `n <= x` (and the other comparisons) and `/re/.test(x)`, by parameter
 * index.
 */
function hintsIn(
  sf: SourceFile,
  body: Expression,
  params: readonly (string | null)[],
): Map<number, Hint> {
  const out = new Map<number, Hint>();
  const position = new Map<string, number>();
  params.forEach((p, i) => {
    if (p !== null) position.set(p, i);
  });
  const merge = (i: number, h: Hint) => {
    const old = out.get(i) ?? {};
    out.set(i, { ...old, ...h });
  };
  for (const conjunct of conjuncts(body)) {
    if (is.isCallExpression(conjunct)) {
      const callee = conjunct.expression;
      const [arg, extra] = conjunct.arguments;
      if (!is.isPropertyAccessExpression(callee) || !is.isIdentifier(callee.name) || !arg || extra)
        continue;
      if (!is.isIdentifier(arg)) continue;
      const at = position.get(arg.text);
      if (at === undefined) continue;
      // Number.isInteger(x)
      if (
        is.isIdentifier(callee.expression) &&
        callee.expression.text === "Number" &&
        callee.name.text === "isInteger"
      )
        merge(at, { integer: true });
      // /re/.test(x)
      else if (is.isRegularExpressionLiteral(callee.expression) && callee.name.text === "test") {
        const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(textOf(sf, callee.expression));
        if (m) merge(at, { regex: { pattern: m[1] as string, flags: m[2] as string } });
      }
      continue;
    }
    // x op n, n op x
    if (!is.isBinaryExpression(conjunct)) continue;
    const op = comparisons[conjunct.operatorToken.kind];
    if (op === undefined) continue;
    const bound = (variable: Expression, literal: Expression, variableOnLeft: boolean) => {
      if (!is.isIdentifier(variable)) return;
      const value = numberText(sf, literal);
      if (value === undefined) return;
      const at = position.get(variable.text);
      if (at === undefined) return;
      // `x < n` bounds x above; `n < x` bounds it below.
      const above = variableOnLeft ? op.startsWith("<") : op.startsWith(">");
      const endpoint: Endpoint = { value, inclusive: op.endsWith("=") };
      merge(at, above ? { upper: endpoint } : { lower: endpoint });
    };
    if (is.isIdentifier(conjunct.left)) bound(conjunct.left, conjunct.right, true);
    else if (is.isIdentifier(conjunct.right)) bound(conjunct.right, conjunct.left, false);
  }
  return out;
}

/**
 * What the precondition says about each of its parameters on its own,
 * read from the arrow's text: see `hintsIn`. A block body gives none.
 */
export function hintsOf(arrow: Arrow): Map<number, Hint> {
  if (arrow.block) return new Map();
  return withSourceFile(`(${arrow.body}\n)`, (sf) => {
    const [first, second] = sf.statements;
    if (second || !first || !is.isExpressionStatement(first)) return new Map();
    let e = first.expression;
    while (is.isParenthesizedExpression(e)) e = e.expression;
    return hintsIn(sf, e, arrow.params);
  });
}

interface SpecExport {
  readonly name: string;
  readonly kind: "forall" | "total";
  readonly fn: string;
  readonly sample?: Arrow;
  readonly when?: Arrow;
  readonly ensures?: Arrow;
  readonly text: string;
  readonly line: number;
  /** The hints the sample and the precondition give, combined per binder index. */
  readonly hints: ReadonlyMap<number, Hint>;
}

class SpecFail extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

/** The module's exports the spec file imports by name, as `local` to exported `name`. */
interface ModuleImport {
  readonly local: string;
  readonly name: string;
}

/** Read the spec file's exports. */
function readSpecSide(
  sf: SourceFile,
  program: Program,
  modulePath: string,
  moduleKey: string,
  specSpecifiers: ReadonlySet<string>,
): { specs: SpecExport[]; errors: SpecError[]; imports: ModuleImport[] } {
  const errors: SpecError[] = [];
  const bound = imports(sf);
  const specs: SpecExport[] = [];
  function fail(message: string, at: Node): never {
    throw new SpecFail(message, lineAt(sf, at));
  }
  // Whether an import's specifier resolves to the module beside the spec file.
  const resolvesToModule = new Map<string, boolean>();
  const fromModule = (imp: Imported): boolean => {
    const known = resolvesToModule.get(imp.from);
    if (known !== undefined) return known;
    const resolved = program.getResolvedModuleFromModuleSpecifier(
      imp.declaration.moduleSpecifier as Parameters<
        Program["getResolvedModuleFromModuleSpecifier"]
      >[0],
      sf.fileName,
    );
    const target = resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
    const is = target !== undefined && target.path === moduleKey;
    resolvesToModule.set(imp.from, is);
    return is;
  };
  /** The combinator a callee names (`forall`, `ns.forall`), or undefined. */
  const combinator = (callee: Expression): "forall" | "total" | undefined => {
    if (is.isPropertyAccessExpression(callee)) {
      if (!is.isIdentifier(callee.expression) || !is.isIdentifier(callee.name)) return undefined;
      const ns = bound.get(callee.expression.text);
      const member = callee.name.text;
      if (
        ns?.name === "*" &&
        specSpecifiers.has(ns.from) &&
        (member === "forall" || member === "total")
      )
        return member;
      return undefined;
    }
    if (!is.isIdentifier(callee)) return undefined;
    const imp = bound.get(callee.text);
    if (imp && specSpecifiers.has(imp.from) && (imp.name === "forall" || imp.name === "total"))
      return imp.name;
    return undefined;
  };
  /** The module function a first argument names, or why not. */
  const functionArg = (arg: Expression | undefined, call: Node): string => {
    if (!arg)
      return fail("the first argument must name a function of the module, found the end", call);
    if (
      is.isPropertyAccessExpression(arg) &&
      is.isIdentifier(arg.expression) &&
      is.isIdentifier(arg.name)
    ) {
      const ns = bound.get(arg.expression.text);
      if (ns?.name === "*" && fromModule(ns)) return arg.name.text;
      return fail(`${textOf(sf, arg)} is not a function imported from the module`, arg);
    }
    if (!is.isIdentifier(arg))
      return fail(
        `the first argument must name a function of the module, found ${textOf(sf, arg)}`,
        arg,
      );
    const imp = bound.get(arg.text);
    if (!imp)
      return fail(
        `${arg.text} is not imported from the module (import it from ./${modulePath.split("/").pop()})`,
        arg,
      );
    if (!fromModule(imp))
      return fail(
        `${arg.text} is imported from ${JSON.stringify(imp.from)}, not from the module beside this spec file`,
        arg,
      );
    if (imp.name === "*" || imp.name === "default")
      return fail(`${arg.text} must be a named import of the module's function`, arg);
    return imp.name;
  };
  /** An arrow function: its params, body text and whether the body is a block. */
  const arrow = (node: Expression, what: string): { arrow: Arrow; node: ArrowFunction } => {
    if (!is.isArrowFunction(node))
      return fail(
        `${what} must be an arrow function, found ${textOf(sf, node).split(/\s/)[0] ?? ""}`,
        node,
      );
    if (isAsync(node)) fail(`${what} is an async arrow; it must be synchronous`, node);
    // A rest or destructured parameter has no name of its own: the binder keeps the function's.
    const params = node.parameters.map((p) =>
      !p.dotDotDotToken && is.isIdentifier(p.name) ? p.name.text : null,
    );
    const body = node.body;
    const line = lineAt(sf, node);
    if (is.isBlock(body))
      return {
        arrow: {
          params,
          body: sf.text.slice(body.getStart(sf) + 1, body.end - 1),
          block: true,
          line,
        },
        node,
      };
    return { arrow: { params, body: textOf(sf, body), block: false, line }, node };
  };
  for (const st of sf.statements) {
    if (!is.isVariableStatement(st)) continue;
    const exported = isExported(st);
    const constant = isConst(st.declarationList);
    for (const d of st.declarationList.declarations) {
      if (!is.isIdentifier(d.name) || !d.initializer) continue;
      const name = d.name.text;
      // `satisfies`, `as`, `!` and parentheses change nothing at runtime: the call is inside them.
      let init: Expression = d.initializer;
      while (
        is.isParenthesizedExpression(init) ||
        is.isSatisfiesExpression(init) ||
        is.isAsExpression(init) ||
        is.isNonNullExpression(init)
      )
        init = init.expression;
      if (!is.isCallExpression(init)) continue;
      const kind = combinator(init.expression);
      if (!kind) continue;
      const line = lineAt(sf, st);
      try {
        if (!exported) fail(`${name} is a spec but not exported, so nothing would check it`, st);
        if (!constant)
          fail(
            `a spec must be a const export, not ${textOf(sf, st).split(/\s/)[exported ? 1 : 0] ?? "let"}`,
            st,
          );
        const [first, second, third] = init.arguments;
        const fn = functionArg(first, init);
        if (kind === "total") {
          if (second) fail("total takes the function alone", second);
          specs.push({ name, kind: "total", fn, text: `total(${fn})`, line, hints: new Map() });
          continue;
        }
        if (!second) return fail("forall takes the function, then { when, ensures }", init);
        if (third) return fail(`unexpected ${textOf(sf, third)} after forall's arguments`, third);
        if (!is.isObjectLiteralExpression(second))
          return fail(
            "forall's second argument must be an object literal { when, ensures }",
            second,
          );
        let sample: { arrow: Arrow; node: ArrowFunction } | undefined;
        let when: { arrow: Arrow; node: ArrowFunction } | undefined;
        let ensures: { arrow: Arrow; node: ArrowFunction } | undefined;
        for (const prop of second.properties) {
          const key =
            is.isPropertyAssignment(prop) ||
            is.isShorthandPropertyAssignment(prop) ||
            is.isMethodDeclaration(prop)
              ? prop.name
              : undefined;
          const keyName =
            key && is.isIdentifier(key) ? key.text : key ? textOf(sf, key) : textOf(sf, prop);
          if (keyName !== "sample" && keyName !== "when" && keyName !== "ensures")
            fail(`forall's properties are sample, when and ensures, found ${keyName}`, prop);
          if (!is.isPropertyAssignment(prop))
            fail(`${keyName} must be written as ${keyName}: (…) => …`, prop);
          const read = arrow(prop.initializer, keyName);
          if (keyName === "sample") {
            if (sample) fail("sample is given twice", prop);
            sample = read;
          } else if (keyName === "when") {
            if (when) fail("when is given twice", prop);
            when = read;
          } else {
            if (ensures) fail("ensures is given twice", prop);
            ensures = read;
          }
        }
        if (!ensures) return fail("forall needs an ensures", second);
        // The precondition and the sample both steer the draws, combined per binder.
        const hintsOfArrow = (
          a: { arrow: Arrow; node: ArrowFunction } | undefined,
        ): Map<number, Hint> =>
          a && !is.isBlock(a.node.body) ? hintsIn(sf, a.node.body, a.arrow.params) : new Map();
        const fromSample = hintsOfArrow(sample);
        const fromWhen = hintsOfArrow(when);
        const hints = new Map<number, Hint>();
        for (const i of new Set([...fromSample.keys(), ...fromWhen.keys()])) {
          const h = combineHints(fromWhen.get(i), fromSample.get(i));
          if (h) hints.set(i, h);
        }
        specs.push({
          name,
          kind: "forall",
          fn,
          ...(sample ? { sample: sample.arrow } : {}),
          ...(when ? { when: when.arrow } : {}),
          ensures: ensures.arrow,
          text: ensures.arrow.body.replace(/\s+/g, " ").trim(),
          line,
          hints,
        });
      } catch (err) {
        if (!(err instanceof SpecFail)) throw err;
        errors.push({ line: err.line, message: `${name}: ${err.message}` });
      }
    }
  }
  const moduleImports: ModuleImport[] = [...bound]
    .filter(([, imp]) => imp.name !== "*" && imp.name !== "default" && fromModule(imp))
    .map(([local, imp]) => ({ local, name: imp.name }));
  return { specs, errors, imports: moduleImports };
}

/** The tighter of two endpoints on one side; the first when they cannot be compared. */
function tighter(
  first: Endpoint | undefined,
  second: Endpoint | undefined,
  side: "lower" | "upper",
): Endpoint | undefined {
  if (!first) return second;
  if (!second) return first;
  // Integral literals compare exactly (bigints reach past every double); others as doubles.
  const integral = (e: Endpoint) => !/[.eE]/.test(e.value);
  let order: number;
  try {
    if (integral(first) && integral(second)) {
      const a = endpointBigInt(first.value);
      const b = endpointBigInt(second.value);
      order = a === b ? 0 : a > b ? 1 : -1;
    } else {
      const a = endpointNumber(first.value);
      const b = endpointNumber(second.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return first;
      order = a === b ? 0 : a > b ? 1 : -1;
    }
  } catch {
    return first;
  }
  if (order !== 0) return (side === "lower" ? order > 0 : order < 0) ? first : second;
  return first.inclusive ? second : first;
}

/**
 * Two hints on one binder as one: integer when either says so, the
 * tighter bound on each side, the first's regex (two cannot be combined,
 * and the draws are checked against both arrows anyway).
 */
function combineHints(first: Hint | undefined, second: Hint | undefined): Hint | undefined {
  if (!first) return second;
  if (!second) return first;
  const lower = tighter(first.lower, second.lower, "lower");
  const upper = tighter(first.upper, second.upper, "upper");
  const regex = first.regex ?? second.regex;
  return {
    ...(first.integer || second.integer ? { integer: true as const } : {}),
    ...(lower ? { lower } : {}),
    ...(upper ? { upper } : {}),
    ...(regex ? { regex } : {}),
  };
}

/** Read a module and its spec file. */
export function readSpecs(input: ReadSpecsInput): ModuleSpecs {
  const modulePath = input.modulePath;
  const specPath = input.specPath ?? modulePath.replace(/\.ts$/, ".props.ts");
  return withProgram(
    [
      { path: modulePath, text: input.module },
      { path: specPath, text: input.spec },
    ],
    ({ program, checker, file, parseError }) => {
      const moduleError = parseError(modulePath);
      const specError = parseError(specPath);
      const errors: SpecError[] = [];
      if (moduleError)
        errors.push({
          line: moduleError.line,
          message: `the module could not be parsed: ${moduleError.message}`,
          inModule: true,
        });
      if (specError)
        errors.push({
          line: specError.line,
          message: `the spec file could not be parsed: ${specError.message}`,
        });
      if (moduleError || specError) return { functions: [], errors };
      const moduleFile = file(modulePath);
      const moduleSide = readModuleSide(moduleFile, checker);
      const specSide = readSpecSide(
        file(specPath),
        program,
        modulePath,
        moduleFile.path,
        new Set(input.specSpecifiers ?? ["eutaxy/spec", "@eutaxy/spec"]),
      );
      errors.push(...moduleSide.errors, ...specSide.errors);
      // The claims' free names: the spec file's local names for the module's declarations.
      const imports = specSide.imports.flatMap((i) => {
        const fn = moduleSide.exports.get(i.name);
        return fn === undefined ? [] : [{ local: i.local, fn }];
      });
      const byFunction = new Map<string, { decl: Declaration; properties: Property[] }>();
      for (const s of specSide.specs) {
        const local = moduleSide.exports.get(s.fn);
        const decl = local === undefined ? undefined : moduleSide.declarations.get(local);
        if (!decl) {
          errors.push({
            line: s.line,
            message: `${s.name}: the module exports no function ${s.fn} whose parameters the reader can read (a function declaration or a const arrow)`,
          });
          continue;
        }
        const entry = byFunction.get(s.fn) ?? { decl, properties: [] };
        if (entry.properties.some((p) => p.name === s.name)) {
          errors.push({ line: s.line, message: `${s.name} is exported twice` });
          continue;
        }
        const binders: Binder[] = decl.params.map((p, i) => {
          const fromEnsures = s.ensures?.params[i];
          const name = fromEnsures ?? p.name ?? `arg${i}`;
          const hint = s.hints.get(i);
          return { name, type: p.type, ...(hint ? { hint } : {}) };
        });
        entry.properties.push({
          name: s.name,
          kind: s.kind,
          binders,
          ...(s.sample ? { sample: s.sample } : {}),
          ...(s.when ? { when: s.when } : {}),
          ...(s.ensures ? { ensures: s.ensures } : {}),
          imports,
          text: s.text,
          line: s.line,
        });
        byFunction.set(s.fn, entry);
      }
      const functions: FunctionSpec[] = [...byFunction.entries()].map(
        ([name, { decl, properties }]) => ({
          name,
          params: decl.params,
          properties,
          line: decl.line,
          offset: decl.offset,
        }),
      );
      return { functions, errors };
    },
  );
}
