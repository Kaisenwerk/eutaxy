/**
 * Spec files for `eutaxy check`: every `<module>.props.ts` next to the
 * scenario, read with its module into `SpecIR` on the Node side, and the
 * generated `specs.ts` that hands workerd each module's specs together
 * with a loader for its spec file. Which of them a run checks is the
 * scenario's `specs`, read where the scenario is loaded, inside the
 * generated test; a spec file loads only when its module is named.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ModuleSpecs } from "@eutaxy/spec";
import { specKey } from "./keys.ts";

export { specKey } from "./keys.ts";

/** The suffix a spec file carries beside its module: `domain.ts` has `domain.props.ts`. */
export const specSuffix = ".props.ts";

export interface SpecModule {
  /** The module's path relative to the scenario's directory, as a scenario names it: "./domain.ts". */
  readonly key: string;
  /** The module's absolute path. */
  readonly path: string;
  /** The spec file's absolute path. */
  readonly specPath: string;
  readonly specs: ModuleSpecs;
}

const skipDirs = new Set(["node_modules", ".eutaxy", "dist", ".git"]);

/** What the spec reader needs that a project without specs need not have. */
export const typescriptNeeded =
  "the TypeScript compiler, version 7.1 or later (typescript), which this project does not have: add it to the project's dev dependencies, or update the one there";

/** A spec file was to be read, or an engine run, where the TypeScript compiler is not installed. */
export class TypescriptNeeded extends Error {}

/**
 * Whether an import failed because the project has no TypeScript compiler the reader can use: none
 * installed (Node finds no package `typescript`), or an older one, which lacks the modules the
 * reader imports (no such export in its package, or no such file in it).
 */
export function typescriptMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code !== "ERR_MODULE_NOT_FOUND" && e?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED")
    return false;
  // The package by name, or a path inside it; not a package whose name only starts the same.
  return /(^|[\\/'"\s])typescript([\\/'"\s]|$)/.test(e.message ?? "");
}

/**
 * The spec reader, loaded when a spec file is first read: it runs the
 * TypeScript compiler, which a project that writes no specs need not have
 * installed, so the command does not load it before then.
 */
async function reader(): Promise<typeof import("@eutaxy/prover/reader")> {
  try {
    return await import("@eutaxy/prover/reader");
  } catch (err) {
    if (typescriptMissing(err))
      throw new TypescriptNeeded(`reading a spec file needs ${typescriptNeeded}`);
    throw err;
  }
}

/** Read one module and its spec file; their imports resolve from where they are. */
export async function readSpecModule(modulePath: string, specPath: string): Promise<ModuleSpecs> {
  const { readSpecs } = await reader();
  return readSpecs({
    module: readFileSync(modulePath, "utf8"),
    spec: readFileSync(specPath, "utf8"),
    modulePath,
    specPath,
  });
}

/**
 * Spec files under `dir`, each with its module; a spec file without a module beside it is an error
 * entry. A directory with no spec file is walked without the spec reader being loaded.
 */
export async function findSpecModules(dir: string): Promise<SpecModule[]> {
  const out: SpecModule[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.name.endsWith(specSuffix)) continue;
      const modulePath = join(at, `${entry.name.slice(0, -specSuffix.length)}.ts`);
      const key = specKey(relative(dir, modulePath));
      if (!existsSync(modulePath)) {
        out.push({
          key,
          path: modulePath,
          specPath: path,
          specs: {
            functions: [],
            errors: [
              {
                line: 1,
                message: `${entry.name} has no module ${basename(modulePath)} beside it`,
              },
            ],
          },
        });
        continue;
      }
      out.push({
        key,
        path: modulePath,
        specPath: path,
        specs: await readSpecModule(modulePath, path),
      });
    }
  };
  await walk(dir);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A file `eutaxy check` writes into `.eutaxy/`, by its path there. */
export interface GeneratedFile {
  readonly name: string;
  readonly source: string;
}

/** A path as an import specifier from `.eutaxy/`: forward slashes, relative, `.ts` kept (Vite resolves it). */
function importFrom(workDir: string, target: string): string {
  const rel = relative(workDir, target).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * The generated `specs.ts`: each module's key mapped to its specs (plain
 * data read on the Node side) and a loader of its spec file. The loader is
 * lazy, so a spec file elsewhere that does not compile cannot stop a check
 * of a scenario that does not name its module.
 */
export function specFiles(modules: readonly SpecModule[], workDir: string): GeneratedFile[] {
  const header = "// Generated by eutaxy check; deleted after the run.";
  const lines = [
    header,
    "// The `any`: this file runs in the user's Vitest, which does not type-check it; `SpecEntry` in workerd.ts is the shape.",
    "export const specEntries: Record<string, { specs: any; load: () => Promise<any> }> = {",
    ...modules.map(
      (m) =>
        `  ${JSON.stringify(m.key)}: { specs: ${JSON.stringify(m.specs)}, load: () => import(${JSON.stringify(importFrom(workDir, m.specPath))}) },`,
    ),
    "};",
  ];
  return [{ name: "specs.ts", source: `${lines.join("\n")}\n` }];
}

/** The directory a generated file's import is resolved from. */
export function specWorkDir(dir: string): string {
  return dirname(join(dir, ".eutaxy", "specs.ts"));
}
