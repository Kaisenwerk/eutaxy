/**
 * The vocabulary in `constructs.json` against the entries: every entry is a
 * construct or a shape and names what it covers from the vocabulary; every
 * construct has an entry of its own under `constructs/`; and what the
 * vocabulary says each engine does with a construct shows in the outcomes
 * the entries covering it expect. `in` needs a verdict from that engine
 * (PROVEN, REFUTED or gave_up) on some covering entry, `out` an
 * `unsupported`. Checked on the manifests, so it needs no toolchain; the
 * harness checks the manifests against the engines.
 */

import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type Engine, entries, kinds, manifest, root, vocabulary } from "./entries.ts";

const constructs = vocabulary();
const ids = Object.keys(constructs);

const outcomesOf = (entry: string, engine: Engine): string[] =>
  Object.values(manifest(entry).expect[engine]).flatMap((byProperty) => Object.values(byProperty));

describe("the contract corpus covers its vocabulary", () => {
  test("every entry is under constructs/ or shapes/", () => {
    const loose = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !(kinds as readonly string[]).includes(d.name))
      .map((d) => d.name)
      .filter((name) => !["dist", "node_modules"].includes(name));
    expect(loose).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  test("every entry covers constructs the vocabulary names; a shape combines several", () => {
    for (const entry of entries) {
      const { covers } = manifest(entry);
      expect(covers.length, entry).toBeGreaterThan(0);
      expect(
        covers.filter((c) => !ids.includes(c)),
        entry,
      ).toEqual([]);
      if (entry.startsWith("shapes/")) expect(covers.length, entry).toBeGreaterThan(1);
    }
  });

  test("every construct has an entry of its own under constructs/", () => {
    const covered = new Set(
      entries.filter((e) => e.startsWith("constructs/")).flatMap((e) => manifest(e).covers),
    );
    expect(ids.filter((id) => !covered.has(id))).toEqual([]);
  });

  test("what each engine does with a construct shows in the entries covering it", () => {
    const wrong: string[] = [];
    for (const [id, c] of Object.entries(constructs))
      for (const engine of ["lean", "smt"] as const) {
        const seen = entries
          .filter((e) => manifest(e).covers.includes(id))
          .flatMap((e) => outcomesOf(e, engine));
        const shows =
          c[engine] === "in"
            ? seen.some((o) => o === "PROVEN" || o === "REFUTED" || o === "gave_up")
            : seen.includes("unsupported");
        if (!shows) wrong.push(`${id}: ${engine} ${c[engine]}`);
      }
    expect(wrong).toEqual([]);
  });

  test("the vocabulary says what each construct is", () => {
    for (const [id, c] of Object.entries(constructs)) {
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(c.what.length, id).toBeGreaterThan(0);
    }
  });
});
