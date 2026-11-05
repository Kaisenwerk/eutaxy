/**
 * The API reference pages (site/reference/api/) are what scripts/reference.ts writes from the source, and
 * every name the published entry points export is found and described there; the site links each page.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  entryPoints,
  exportsOf,
  firstSentence,
  pagePath,
  referencePage,
} from "../scripts/reference.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe.each(entryPoints)("the reference page of $specifier", (entry) => {
  test("is up to date with the source (node scripts/reference.ts rewrites it)", () => {
    expect(readFileSync(pagePath(entry), "utf8")).toBe(referencePage(entry));
  });

  test("finds and describes every name the entry point exports", () => {
    const names = exportsOf(entry);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.kind === "unknown").map((n) => n.name)).toEqual([]);
    // A public name without a doc comment would show as a blank row: write one at its declaration.
    expect(names.filter((n) => !n.summary).map((n) => `${n.name} (${n.source}:${n.line})`)).toEqual(
      [],
    );
  });

  test("is in the site's sidebar", () => {
    const config = readFileSync(join(root, "site", ".vitepress", "config.ts"), "utf8");
    expect(config).toContain(`link: "/reference/api/${entry.page}"`);
  });
});

test("a summary is the doc comment's first sentence, whatever the parentheses and code spans hold", () => {
  expect(firstSentence("Run it (once. or twice). Then more.")).toBe("Run it (once. or twice).");
  expect(firstSentence("The `a.b` path. More.")).toBe("The `a.b` path.");
  expect(firstSentence("No full stop")).toBe("No full stop");
});

test("a signature is read across lines, and the page keeps `<` where Markdown and Vue would eat it", () => {
  const cloudflare = entryPoints.find((e) => e.specifier === "eutaxy/cloudflare");
  const names = exportsOf(cloudflare as (typeof entryPoints)[number]);
  const callee = names.find((n) => n.name === "callee");
  expect(callee?.signature).toMatch(/^\(binding: string, worker: \{ readonly entry: string;/);
  // A callback type's arrow is not a closing bracket: the signature ends at the return type.
  const spec = entryPoints.find((e) => e.specifier === "eutaxy/spec");
  const forall = exportsOf(spec as (typeof entryPoints)[number]).find((n) => n.name === "forall");
  expect(forall?.signature).toBe(
    "<F extends Fn>(fn: F, property: { readonly sample?: (...args: Parameters<F>) => boolean; readonly when?: (...args: Parameters<F>) => boolean; readonly ensures: (...args: Parameters<F>) => boolean; }): Forall<F>",
  );
  const page = referencePage(cloudflare as (typeof entryPoints)[number]);
  // Inside a code span `<` shows as written; in prose it is escaped, where Vue would read a tag.
  expect(page).toContain("aliases: Readonly<Record<string, string>> = {}): object`");
  expect(page).toContain("each mapped onto `<name>/<key>`");
});
