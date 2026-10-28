/**
 * Proofs supplied beside a spec file, for claims the engine's tactic
 * script does not close: `domain.props.lean` beside `domain.props.ts`.
 * Lemmas come first; then each `-- proof: <property>` line opens the
 * tactic proof of that property's statement, which Eutaxy emits and the
 * proof cannot change (it is fixed as a definition before any supplied
 * text). Lean's kernel checks the proof, and Eutaxy accepts it only when
 * it rests on Lean's standard axioms; what could switch checking off, add
 * an axiom or change how the statement reads is refused outright.
 */

export interface SuppliedProofs {
  /** The proof file's name, for verdicts. */
  readonly file: string;
  /** Everything before the first `-- proof:` line: lemmas the proofs use. */
  readonly lemmas: string;
  /** Each property's tactic proof, by property name (the names also when the file is refused). */
  readonly proofs: ReadonlyMap<string, string>;
  /** Why the file is refused, when it is; then none of its proofs is used, and its properties say why. */
  readonly refused?: string;
}

/** The axioms a supplied proof may rest on: Lean's standard ones. */
export const standardAxioms: ReadonlySet<string> = new Set([
  "propext",
  "Classical.choice",
  "Quot.sound",
]);

/**
 * Words a supplied proof may not use, anywhere in the file, comments and
 * strings included: what adds axioms or trusted code (`axiom`, `sorry`,
 * `unsafe`, `implemented_by`, `extern`, `opaque`, `native_decide`),
 * switches checks off (`set_option`), registers code Lean would run while
 * the file is checked (`attribute`, `initialize`, `simproc` and the like)
 * or changes how text reads (`macro`, `syntax`, `notation` and the like),
 * and `import`. The list narrows when a legitimate proof is refused and
 * grows only with a Lean bump that adds such a command (see
 * `leanToolchain`); never because of what a hostile file could do, which
 * the design answers.
 */
const refusedWords = [
  "sorry",
  "admit",
  "axiom",
  "unsafe",
  "implemented_by",
  "extern",
  "opaque",
  "native_decide",
  "set_option",
  "macro",
  "macro_rules",
  "syntax",
  "notation",
  "infix",
  "infixl",
  "infixr",
  "prefix",
  "postfix",
  "elab",
  "elab_rules",
  "import",
  "attribute",
  "initialize",
  "simproc",
  "dsimproc",
  "simproc_decl",
  "dsimproc_decl",
  // Section variables become hypotheses of the theorems after them: `variable (h : False)` would.
  "section",
  "namespace",
  "variable",
  "include",
  "omit",
  "universe",
];

/** Command families refused by how a word starts: `run_cmd`, `builtin_initialize`, `register_option`, `declare_syntax_cat`. */
const refusedStarts = ["run_", "builtin_", "register_", "declare_"];

/**
 * Refused wherever they appear, inside a name too: every command run
 * while the file is checked starts with `#`, and every attribute (which
 * can hand Lean a tactic, an elaborator or a simplification procedure to
 * run) with `@[`.
 */
const refusedAnywhere = ["#", "@["];

/** Lean's ASCII identifier characters after the first. */
const identRest = /[A-Za-z0-9_'!?]/u;

/**
 * Whether the text just before `at` continues a name, so that a word
 * starting there is part of that name rather than a token of its own.
 * Only a run of identifier characters that starts with an ASCII letter or
 * `_` counts: one that starts with a digit is a numeral, and Lean starts a
 * new token right after a numeral (`0xfsorry` is `0xf`, then `sorry`).
 * Anything else (`.`, `«`, Unicode) counts as a boundary, which refuses
 * more, never less.
 */
function continuesName(text: string, at: number): boolean {
  let i = at;
  while (i > 0 && identRest.test(text[i - 1] as string)) i--;
  return i < at && /[A-Za-z_]/u.test(text[i] as string);
}

/** The first refused word or command the text holds, as a token of its own, or undefined. */
export function refusedIn(text: string): string | undefined {
  const anywhere = refusedAnywhere.find((w) => text.includes(w));
  if (anywhere !== undefined) return anywhere;
  for (const [words, whole] of [
    [refusedWords, true],
    [refusedStarts, false],
  ] as const) {
    for (const w of words) {
      for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + 1)) {
        if (continuesName(text, at)) continue;
        // A whole word followed by an identifier character is a longer name, which Lean reads as one.
        if (whole && identRest.test(text[at + w.length] ?? "")) continue;
        return w;
      }
    }
  }
  return undefined;
}

/** `-- proof: <property>`: any name the spec file can export, Unicode letters included. */
const marker = /^-- proof: (\S+)\s*$/u;

/** Read a proof file: its lemmas, its proofs by property, or why it is refused. */
export function readSupplied(file: string, text: string): SuppliedProofs {
  const lemmas: string[] = [];
  const proofs = new Map<string, string[]>();
  let current: string[] = lemmas;
  let twice: string | undefined;
  for (const line of text.split("\n")) {
    const m = marker.exec(line);
    if (!m) {
      current.push(line);
      continue;
    }
    const name = m[1] as string;
    twice ??= proofs.has(name) ? name : undefined;
    current = [];
    proofs.set(name, current);
  }
  if (twice !== undefined) return refuse({ file, proofs }, `${file} proves ${twice} twice`);
  // Checked over the whole text, comments and strings too: telling them apart is lexing Lean, and a
  // lexer that slips (`"/-"` in a string read as a comment) would let a refused command through. A
  // refused word in a comment refuses the file as well, which costs a word, never soundness.
  const word = refusedIn(text);
  if (word !== undefined)
    return refuse(
      { file, proofs },
      `${file} uses ${word}, which a supplied proof may not (it could add an axiom, switch a check off, run code while the file is checked or change how the statement reads)`,
    );
  return {
    file,
    lemmas: lemmas.join("\n").trim(),
    proofs: new Map([...proofs].map(([k, v]) => [k, v.join("\n").replace(/\s+$/, "")])),
  };
}

/** The file refused: none of its proofs is used, and every property it names says why. */
export function refuse(
  supplied: { readonly file: string; readonly proofs: ReadonlyMap<string, unknown> },
  reason: string,
): SuppliedProofs {
  return {
    file: supplied.file,
    lemmas: "",
    proofs: new Map([...supplied.proofs.keys()].map((k) => [k, ""])),
    refused: reason,
  };
}

/** Lean's messages at one line: an audit is read only when Lean's own message is the only one there. */
function onlyAt(
  messages: readonly {
    readonly line: number;
    readonly severity: string;
    readonly message: string;
  }[],
  line: number,
): string | undefined {
  const at = messages.filter((m) => m.line === line);
  return at.length === 1 && at[0]?.severity === "info" ? at[0].message : undefined;
}

/**
 * The axioms Lean reports a theorem depends on: the message of the
 * `#print axioms` at `line`, Eutaxy's own audit command, and no other.
 * Undefined unless that message is the only one at the line: anything
 * else there (a forged copy, printed by code the file ran) makes the
 * audit unreadable rather than letting either message stand.
 */
export function axiomsOf(
  messages: readonly {
    readonly line: number;
    readonly severity: string;
    readonly message: string;
  }[],
  line: number,
  theorem: string,
): string[] | undefined {
  const message = onlyAt(messages, line);
  if (message === undefined) return undefined;
  if (message === `'${theorem}' does not depend on any axioms`) return [];
  const prefix = `'${theorem}' depends on axioms: [`;
  if (message.startsWith(prefix) && message.endsWith("]"))
    return message
      .slice(prefix.length, -1)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  return undefined;
}

/**
 * Whether Lean's message at the `#check` of a supplied theorem shows it
 * proves exactly its fixed statement `s_<name>`: no hypothesis added (a
 * section variable would show as `False → …`).
 */
export function provesExactly(
  messages: readonly {
    readonly line: number;
    readonly severity: string;
    readonly message: string;
  }[],
  line: number,
  theorem: string,
): boolean {
  return onlyAt(messages, line) === `${theorem} : s_${theorem}`;
}
