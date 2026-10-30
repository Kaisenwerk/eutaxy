/**
 * The TypeScript compiler, through its API (7.1): one compiler process per
 * Node process, started on first use; a program per read, over an
 * in-memory layer holding the files being read on top of the host's own
 * files, so imports resolve as the user's compiler resolves them; a
 * standalone source file for text that is not a module (a spec file's
 * arrow, read back from its text). Every handle the compiler process
 * holds for a read is released when the read ends. Nothing else in Eutaxy
 * imports the compiler API: a change to it lands here.
 */

import {
  type FunctionLikeBase,
  type Identifier,
  ModifierFlags,
  type ModifiersBase,
  type Node,
  NodeFlags,
  type SourceFile,
  SyntaxKind,
  type VariableDeclarationList,
} from "typescript/ast";
import { createFileSystemLayer } from "typescript/fs";
import { API, type Checker, DiagnosticCategory, type Program } from "typescript/sync";

let api: API | undefined;

function compiler(): API {
  api ??= new API({});
  return api;
}

/** Stop the compiler process; the next read starts another. */
export function closeCompiler(): void {
  api?.close();
  api = undefined;
}

/**
 * The options every read compiles under: strict, the latest language
 * level, bundler-style resolution with `.ts` imports allowed, and the
 * standard library alone (`types: []`), so a module's own types resolve
 * and nothing is emitted. The user's configuration is not read: a type
 * Eutaxy cannot resolve under these options is reported unknown, never
 * guessed.
 */
const options = {
  strict: true,
  target: 99, // ScriptTarget.ESNext
  module: 99, // ModuleKind.ESNext
  moduleResolution: 100, // ModuleResolutionKind.Bundler
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: [] as string[],
  lib: ["es2023"],
};

/** A file given to a read: its path, under which imports resolve, and its text, which stands in for the file on disk. */
export interface InputFile {
  readonly path: string;
  readonly text: string;
}

/** A program over the input files, with its checker. */
export interface Opened {
  readonly program: Program;
  readonly checker: Checker;
  /** The source file of an input path. */
  readonly file: (path: string) => SourceFile;
  /** The first parse error of an input file, if any. */
  readonly parseError: (path: string) => { line: number; message: string } | undefined;
  /** The compiler's errors in a file of the program: text ranges (offsets into the file), with the message and its line. */
  readonly typeErrors: (path: string) => readonly CompilerError[];
  /**
   * Whether an identifier names the global of its name: the compiler
   * resolves it to a symbol declared in its default library alone
   * (`lib.*.d.ts`). A declaration, import or block-scoped shadow of the
   * name in scope, a global declared by the project's own declaration
   * files, or a name the compiler cannot resolve is not; a type-only
   * import of the name is, since the compiler resolves a value past it,
   * and so is an interface augmentation of its type (`declare global {
   * interface Number { … } }`), which changes no value.
   */
  readonly standardGlobal: (id: Identifier) => boolean;
}

/** One compiler error in a file: its text range, message and 1-based line. */
export interface CompilerError {
  readonly pos: number;
  readonly end: number;
  readonly message: string;
  readonly line: number;
}

/** Run `fn` over a program whose root files are the inputs, released afterwards. */
export function withProgram<T>(files: readonly InputFile[], fn: (opened: Opened) => T): T {
  const snapshot = compiler().createSnapshot({
    fileSystem: createFileSystemLayer(files.map((f) => [f.path, f.text] as const)),
    createPrograms: [{ rootFiles: files.map((f) => f.path), compilerOptions: options }],
  });
  try {
    const program = snapshot.operation.createdPrograms[0];
    const checker = program.getProject().checker;
    const file = (path: string): SourceFile => {
      const sf = program.getSourceFile(path);
      if (!sf) throw new Error(`the compiler holds no source file for ${path}`);
      return sf;
    };
    const parseError = (path: string) => {
      const first = program.getSyntacticDiagnostics(path)[0];
      return first
        ? { line: (first.startPosition?.line ?? 0) + 1, message: first.text }
        : undefined;
    };
    const errors = new Map<string, readonly CompilerError[]>();
    const typeErrors = (path: string) => {
      let found = errors.get(path);
      if (!found) {
        found = program
          .getSemanticDiagnostics(path)
          .filter((d) => d.category === DiagnosticCategory.Error)
          .map((d) => ({
            pos: d.pos,
            end: d.end,
            message: d.text,
            line: (d.startPosition?.line ?? 0) + 1,
          }));
        errors.set(path, found);
      }
      return found;
    };
    // Answers by symbol: the global `Math` is one symbol however often it is named. Interface and
    // type alias declarations merge into a symbol without touching its value, so only the others decide.
    const standard = new Map<number, boolean>();
    const typeOnly = new Set([SyntaxKind.InterfaceDeclaration, SyntaxKind.TypeAliasDeclaration]);
    const standardGlobal = (id: Identifier): boolean => {
      const symbol = checker.getSymbolAtLocation(id);
      if (!symbol) return false;
      let known = standard.get(symbol.id);
      if (known === undefined) {
        const values = symbol.declarations.filter((d) => !typeOnly.has(d.kind));
        known =
          values.length > 0 &&
          values.every((d) => {
            const sf = d.resolve()?.getSourceFile();
            return sf !== undefined && program.isSourceFileDefaultLibrary(sf);
          });
        standard.set(symbol.id, known);
      }
      return known;
    };
    return fn({ program, checker, file, parseError, typeErrors, standardGlobal });
  } finally {
    snapshot.dispose();
  }
}

/** Run `fn` over a source file parsed from `text` alone (no program, no checker), released afterwards. */
export function withSourceFile<T>(text: string, fn: (sf: SourceFile) => T): T {
  const lease = compiler().createSourceFile("/eutaxy/reader/fragment.ts", text);
  try {
    return fn(lease.sourceFile);
  } finally {
    lease.dispose();
  }
}

/** 1-based line of a node's first token. */
export function lineAt(sf: SourceFile, node: Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** A node's text, leading trivia excluded. */
export function textOf(sf: SourceFile, node: Node): string {
  return sf.text.slice(node.getStart(sf), node.end);
}

export function isExported(node: ModifiersBase): boolean {
  return (node.modifierFlags & ModifierFlags.Export) !== 0;
}

export function isAsync(node: ModifiersBase): boolean {
  return (node.modifierFlags & ModifierFlags.Async) !== 0;
}

export function isConst(list: VariableDeclarationList): boolean {
  return (list.flags & NodeFlags.Const) !== 0;
}

/**
 * The offset of the `(` opening a function's parameter list: the
 * declaration's identity, as the spec reader and the subset reader both
 * record it. Undefined for an arrow written without parentheses.
 */
export function openParen(sf: SourceFile, fn: FunctionLikeBase): number | undefined {
  const at = fn.parameters.pos - 1;
  return sf.text[at] === "(" ? at : undefined;
}

/** The name of a syntax kind, for messages. */
export function kindName(kind: SyntaxKind): string {
  return SyntaxKind[kind] ?? String(kind);
}
