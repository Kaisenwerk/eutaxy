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
  ModifierFlags,
  type ModifiersBase,
  type Node,
  NodeFlags,
  type SourceFile,
  SyntaxKind,
  type VariableDeclarationList,
} from "typescript/ast";
import { createFileSystemLayer } from "typescript/fs";
import { API, type Checker, type Program } from "typescript/sync";

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
    return fn({ program, checker, file, parseError });
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
