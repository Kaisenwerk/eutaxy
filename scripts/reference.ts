/**
 * The API reference pages: one per entry point of the published package
 * (`eutaxy`, `eutaxy/cloudflare`, `eutaxy/aws`, `eutaxy/spec`), listing
 * every name it exports with its kind, its signature (for a function) and
 * the first sentence of its doc comment, read from the declaration in the
 * workspace package it comes from. The pages are committed under
 * `site/reference/api/`; a test fails when they differ from what this
 * writes, so the reference cannot drift from the exports.
 *
 * Usage: node scripts/reference.ts   (rewrites the pages)
 *
 * The sources are read as text, not compiled: the facade's `export { … }
 * from "<package>"` blocks, each package's own re-exports, and the
 * declaration's `export function|interface|type|class|const` line.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const facade = join(root, "packages", "eutaxy", "src");
const repo = "https://github.com/Kaisenwerk/eutaxy/blob/main";

/** An entry point of the published package: its import path, its facade module, its page. */
export interface EntryPoint {
  readonly specifier: string;
  readonly file: string;
  readonly page: string;
  readonly title: string;
}

export const entryPoints: readonly EntryPoint[] = [
  { specifier: "eutaxy", file: "index.ts", page: "eutaxy", title: "eutaxy" },
  {
    specifier: "eutaxy/cloudflare",
    file: "cloudflare.ts",
    page: "cloudflare",
    title: "eutaxy/cloudflare",
  },
  { specifier: "eutaxy/aws", file: "aws.ts", page: "aws", title: "eutaxy/aws" },
  { specifier: "eutaxy/spec", file: "spec.ts", page: "spec", title: "eutaxy/spec" },
];

/** One exported name, as the reference lists it. */
export interface ExportedName {
  readonly name: string;
  readonly kind: "function" | "class" | "const" | "interface" | "type" | "enum" | "unknown";
  /** A function's parameters and return type, as written. */
  readonly signature?: string;
  /** The doc comment's first sentence; empty when the declaration has none. */
  readonly summary: string;
  /** The declaring file, relative to the repository. */
  readonly source: string;
  readonly line: number;
}

/** The names an `export { … } from "…"` block lists, with what each is named in its module. */
function exportBlocks(src: string): { local: string; exported: string; from: string }[] {
  const out: { local: string; exported: string; from: string }[] = [];
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of (m[1] as string).split(",")) {
      const name = part
        .replace(/\/\/.*$/gm, "")
        .replace(/^\s*type\s+/, "")
        .trim();
      if (!name) continue;
      const [local, exported] = name.split(/\s+as\s+/) as [string, string | undefined];
      out.push({ local: local.trim(), exported: (exported ?? local).trim(), from: m[2] as string });
    }
  }
  return out;
}

/** A module specifier, from `file`, to a source file: a workspace package's entry, or a relative path. */
function resolveModule(from: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const p = resolve(dirname(from), specifier);
    return [p, p.replace(/\.js$/, ".ts"), `${p}.ts`].find(
      (c) => existsSync(c) && c.endsWith(".ts"),
    );
  }
  const m = /^@eutaxy\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!m) return undefined;
  const pkg = join(root, "packages", m[1] as string);
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    exports?: Record<string, string | { default?: string }>;
  };
  const key = m[2] === undefined ? "." : `./${m[2]}`;
  const target = manifest.exports?.[key];
  const path = typeof target === "string" ? target : target?.default;
  return path === undefined ? undefined : join(pkg, path);
}

const declaration =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(async\s+function|function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** The doc comment that ends right above line `index` of `lines`, if any. */
function docAbove(lines: readonly string[], index: number): string {
  let i = index - 1;
  while (i >= 0 && /^\s*\/\//.test(lines[i] as string)) i--;
  if (i < 0 || !/\*\/\s*$/.test(lines[i] as string)) return "";
  let start = i;
  while (start >= 0 && !/\/\*\*/.test(lines[start] as string)) start--;
  if (start < 0) return "";
  return lines
    .slice(start, i + 1)
    .join("\n")
    .replace(/^\s*\/\*\*\s?/, "")
    .replace(/\s*\*\/\s*$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of a doc comment: up to the first ". " or ": " that ends a clause at depth 0. */
export function firstSentence(doc: string): string {
  let depth = 0;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i] as string;
    if (c === "(" || c === "`" || c === "[") depth += c === "`" ? (depth % 2 === 0 ? 1 : -1) : 1;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === "." && (doc[i + 1] === " " || i === doc.length - 1))
      return doc.slice(0, i + 1);
  }
  return doc;
}

/** A function's parameters and return type: the text from its `(` to the `{` that opens its body. */
function functionSignature(lines: readonly string[], index: number): string {
  const text = lines.slice(index, index + 40).join("\n");
  const open = text.indexOf("(");
  if (open < 0) return "";
  // Generic parameters between the name and the parenthesis are part of the signature.
  const head = text.slice(0, open);
  const generic = /<[^(]*>\s*$/.exec(head)?.[0] ?? "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "(" || c === "<" || c === "[") depth++;
    else if (c === ")" || c === ">" || c === "]") depth--;
    else if (c === "{" && depth === 0)
      return `${generic}${text.slice(open, i)}`
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/,\s*\)/g, ")")
        .trim();
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return "";
}

/** Where `name` is declared, following the re-exports of `file` and the modules they name. */
function findDeclaration(
  file: string,
  name: string,
  seen = new Set<string>(),
): Omit<ExportedName, "name"> | undefined {
  if (seen.has(`${file}#${name}`)) return undefined;
  seen.add(`${file}#${name}`);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = declaration.exec(lines[i] as string);
    if (!m || m[2] !== name) continue;
    const word = (m[1] as string).replace(/^async\s+/, "");
    const kind = word === "let" ? "const" : (word as ExportedName["kind"]);
    const signature = kind === "function" ? functionSignature(lines, i) : undefined;
    return {
      kind,
      ...(signature ? { signature } : {}),
      summary: firstSentence(docAbove(lines, i)),
      source: relative(root, file).split("\\").join("/"),
      line: i + 1,
    };
  }
  for (const e of exportBlocks(src)) {
    if (e.exported !== name) continue;
    const target = resolveModule(file, e.from);
    if (target) {
      const found = findDeclaration(target, e.local, seen);
      if (found) return found;
    }
  }
  // `export { name }` of a name the module imported: the import says where it is declared.
  const listed = [...src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*;/g)].some((m) =>
    (m[1] as string).split(",").some((p) => p.replace(/^\s*type\s+/, "").trim() === name),
  );
  if (listed)
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      const imported = (m[1] as string).split(",").map((p) => p.replace(/^\s*type\s+/, "").trim());
      if (!imported.includes(name)) continue;
      const target = resolveModule(file, m[2] as string);
      const found = target ? findDeclaration(target, name, seen) : undefined;
      if (found) return found;
    }
  for (const m of src.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const target = resolveModule(file, m[1] as string);
    const found = target ? findDeclaration(target, name, seen) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Every name an entry point exports, sorted, with what its declaration says. */
export function exportsOf(entry: EntryPoint): ExportedName[] {
  const file = join(facade, entry.file);
  const names = exportBlocks(readFileSync(file, "utf8"));
  return names
    .map((n) => {
      const target = resolveModule(file, n.from);
      const found = target ? findDeclaration(target, n.local) : undefined;
      return {
        name: n.exported,
        ...(found ?? { kind: "unknown" as const, summary: "", source: "", line: 0 }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Prose: `<` escaped outside code spans, where Vue would read it as a tag; inside one it shows as written. */
const escapeProse = (s: string): string =>
  s
    .split("`")
    .map((part, i) => (i % 2 === 0 ? part.replace(/</g, "&lt;") : part))
    .join("`");

/** A code span holding `text`, with a fence longer than any run of backticks inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** One name's entry: a heading (its anchor), its declaration in short, what it is, and its source. */
function entrySection(n: ExportedName): string[] {
  const declared =
    n.kind === "function"
      ? `function ${n.name}${n.signature ?? "(…)"}`
      : `${n.kind === "const" ? "const" : n.kind} ${n.name}`;
  // The file, not the line: a page that names lines would go stale with every edit above them.
  const source = n.source ? ` [Source](${repo}/${n.source})` : "";
  return [
    `### ${codeSpan(n.name)}`,
    "",
    codeSpan(declared),
    "",
    `${escapeProse(n.summary)}${source}`,
    "",
  ];
}

/** The Markdown page for one entry point. */
export function referencePage(entry: EntryPoint): string {
  const names = exportsOf(entry);
  const values = names.filter((n) => ["function", "class", "const", "enum"].includes(n.kind));
  const types = names.filter((n) => !values.includes(n));
  const section = (title: string, list: readonly ExportedName[]): string[] => [
    `## ${title}`,
    "",
    ...(list.length === 0 ? ["None.", ""] : list.flatMap(entrySection)),
  ];
  return [
    "---",
    `title: "${entry.title}"`,
    `description: Every name the ${entry.specifier} entry point exports, with its signature and what it is, generated from the source.`,
    "outline: 2",
    "---",
    "",
    `<!-- Generated by scripts/reference.ts from packages/eutaxy/src/${entry.file}; do not edit. -->`,
    "",
    `# \`${entry.specifier}\``,
    "",
    `\`import { … } from "${entry.specifier}";\` ${values.length} functions and values, ${types.length} types; each links to the file that declares it.`,
    "",
    ...section("Functions, classes and values", values),
    ...section("Types", types),
  ].join("\n");
}

/** Where each entry point's page lives. */
export const pagePath = (entry: EntryPoint): string =>
  join(root, "site", "reference", "api", `${entry.page}.md`);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const entry of entryPoints) writeFileSync(pagePath(entry), referencePage(entry));
}
