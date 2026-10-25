/**
 * The README on the npm page. npm shows the README.md at the root of the
 * tarball, which for `eutaxy` is the facade's package note for contributors.
 * At release this writes the repository README in its place, with relative
 * links made absolute: npm resolves them against `repository.directory`,
 * where `docs/` and `examples/` do not exist.
 *
 * Usage: node scripts/npm-readme.ts <git ref> <output path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Rewrites every relative Markdown link target to `<repoUrl>/blob/<ref>/<target>`. */
export function npmReadme(markdown: string, repoUrl: string, ref: string): string {
  const base = `${repoUrl.replace(/\.git$/, "")}/blob/${ref}/`;
  return markdown.replace(
    /\]\((?![a-z][a-z0-9+.-]*:|#|\/)(?:\.\/)?([^)\s]+)\)/gi,
    (_, target: string) => `](${base}${target})`,
  );
}

/** The repository's URL, from the published package's `repository` field. */
export function repositoryUrl(): string {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages", "eutaxy", "package.json"), "utf8"),
  ) as {
    repository: { url: string };
  };
  return pkg.repository.url.replace(/^git\+/, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [ref, out] = process.argv.slice(2);
  if (ref === undefined || out === undefined) {
    console.error("usage: node scripts/npm-readme.ts <git ref> <output path>");
    process.exit(1);
  }
  const markdown = readFileSync(join(root, "README.md"), "utf8");
  writeFileSync(out, npmReadme(markdown, repositoryUrl(), ref));
}
