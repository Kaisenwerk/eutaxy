/**
 * Print SpecIR back as Lemma, canonically: glyph connectives, binders with
 * the same domain and guard grouped, and parentheses only where precedence
 * or a root-level material implication needs them. Parsing what it prints
 * gives the same IR.
 */

import type { Binder, Formula, Guard, Property } from "./ir.ts";

const precedence: { readonly [k in Formula["kind"]]: number } = {
  iff: 1,
  implies: 2,
  or: 3,
  and: 4,
  not: 5,
  atom: 6,
  equation: 6,
};

function guardText(g: Guard): string {
  if (g.kind === "regex") return `/${g.pattern}/${g.flags}`;
  return `${g.lower.inclusive ? "[" : "("}${g.lower.value}, ${g.upper.value}${g.upper.inclusive ? "]" : ")"}`;
}

function sameGroup(a: Binder, b: Binder): boolean {
  return (
    a.domain === b.domain &&
    (a.guard === undefined) === (b.guard === undefined) &&
    (a.guard === undefined || (b.guard !== undefined && guardText(a.guard) === guardText(b.guard)))
  );
}

function prefixText(binders: readonly Binder[]): string {
  const groups: Binder[][] = [];
  for (const b of binders) {
    const last = groups[groups.length - 1];
    if (last && sameGroup(last[0] as Binder, b)) last.push(b);
    else groups.push([b]);
  }
  const text = groups.map((g) => {
    const head = g[0] as Binder;
    const guard = head.guard ? ` ∈ ${guardText(head.guard)}` : "";
    return `(${g.map((b) => b.name).join(" ")}: ${head.domain}${guard})`;
  });
  return `forall ${text.join(" ")}`;
}

/** Print a formula, parenthesized when its precedence is below `min`. */
export function printFormula(f: Formula, min = 0): string {
  let s: string;
  switch (f.kind) {
    case "atom":
      s = f.text;
      break;
    case "equation":
      s = `${f.left} ${f.negated ? "≢" : "≡"} ${f.right}`;
      break;
    case "not":
      s = `¬${printFormula(f.operand, precedence.not)}`;
      break;
    case "and":
    case "or":
      s = f.operands
        .map((o) => printFormula(o, precedence[f.kind] + 1))
        .join(f.kind === "and" ? " ∧ " : " ∨ ");
      break;
    case "implies":
      s = [...f.antecedents, f.consequent].map((o) => printFormula(o, precedence.or)).join(" → ");
      break;
    case "iff":
      s = `${printFormula(f.left, precedence.implies)} ↔ ${printFormula(f.right, precedence.implies)}`;
      break;
  }
  return precedence[f.kind] < min ? `(${s})` : s;
}

/** The property as Lemma text (what follows `@ensures{name}`). */
export function printProperty(p: Property): string {
  // A root implication is the preconditions; a material one there needs its parentheses.
  const body =
    p.requires.length > 0
      ? [...p.requires, p.claim].map((f) => printFormula(f, precedence.or)).join(" → ")
      : printFormula(p.claim, p.claim.kind === "implies" ? precedence.or : 0);
  return `${prefixText(p.binders)} { ${body} }`;
}
