/** The Lemma conformance corpus: accept everything under accept/, reject everything under reject/. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LemmaSyntaxError, parseProperty, printProperty } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

function fixtures(dir: "accept" | "reject"): [string, string][] {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const { annotation } = JSON.parse(readFileSync(join(root, dir, f), "utf8")) as {
        annotation: string;
      };
      return [f, annotation];
    });
}

describe("Lemma conformance", () => {
  test("the corpus is there", () => {
    expect(fixtures("accept").length).toBeGreaterThan(0);
    expect(fixtures("reject").length).toBeGreaterThan(0);
  });

  test.each(fixtures("accept"))("accepts %s", (_, annotation) => {
    const parsed = parseProperty(annotation);
    // Printing is canonical: what it prints parses to the same IR.
    expect(parseProperty(printProperty(parsed))).toEqual(parsed);
  });

  test.each(fixtures("reject"))("rejects %s", (_, annotation) => {
    expect(() => parseProperty(annotation)).toThrow(LemmaSyntaxError);
  });
});
