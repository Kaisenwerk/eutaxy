/**
 * Proves the claim in CLAUDE.md and every package README: a package can only
 * import what its package.json declares, because pnpm links only declared
 * workspace dependencies, so an undeclared import does not resolve at all.
 * The TypeScript project references mirror the declared dependencies (for
 * build order) and the allowed-imports table from docs/design.md.
 *
 * Compile cases write a throwaway composite project inside a real package, so
 * module resolution is exactly what package code sees, and run `tsc -b` on it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", ".bin", "tsc");

interface Outcome {
  readonly status: number;
  readonly output: string;
}

function build(fixtureDir: string): Outcome {
  try {
    const output = execFileSync(tsc, ["-b", join(fixtureDir, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function withFixture(
  pkg: string,
  references: readonly string[],
  source: string,
  run: (outcome: Outcome) => void,
): void {
  const pkgDir = join(root, "packages", pkg);
  const dir = mkdtempSync(join(pkgDir, ".layering-fixture-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "probe.ts"), source);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "../../../tsconfig.base.json",
        compilerOptions: { rootDir: "src", outDir: "dist" },
        include: ["src"],
        references: references.map((r) => ({ path: `../../${r}` })),
      }),
    );
    run(build(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The allowed-imports table from docs/design.md. */
const allowed: Readonly<Record<string, readonly string[]>> = {
  spec: [],
  core: ["spec"],
  engine: ["core"],
  cloudflare: ["engine", "core"],
  aws: ["engine", "core"],
  prover: ["core", "spec"],
  "prover-lean": ["prover", "spec"],
  "prover-thales": ["prover"],
  "prover-lemmascript": ["prover"],
  report: ["core"],
  cli: [
    "spec",
    "core",
    "engine",
    "cloudflare",
    "aws",
    "prover",
    "prover-lean",
    "prover-thales",
    "prover-lemmascript",
    "report",
  ],
  eutaxy: [
    "spec",
    "core",
    "engine",
    "cloudflare",
    "aws",
    "prover",
    "prover-lean",
    "prover-thales",
    "prover-lemmascript",
    "report",
    "cli",
  ],
};

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("declared dependencies match the design", () => {
  for (const [pkg, deps] of Object.entries(allowed)) {
    test(`${pkg} declares exactly its allowed imports and references them`, () => {
      const dir = join(root, "packages", pkg);
      const pj = readJson(join(dir, "package.json"));
      // The facade bundles its internal packages, so it declares them as devDependencies.
      const field = pkg === "eutaxy" ? "devDependencies" : "dependencies";
      const all = (pj[field] as Record<string, string> | undefined) ?? {};
      const declared = Object.keys(all)
        .filter((n) => n.startsWith("@eutaxy/"))
        .map((n) => n.replace(/^@eutaxy\//, ""))
        .sort();
      expect(declared).toEqual([...deps].sort());
      for (const [n, v] of Object.entries(all)) {
        if (n.startsWith("@eutaxy/")) expect(v).toBe("workspace:*");
      }
      expect(
        pj["dependencies"] === undefined ||
          !Object.keys(pj["dependencies"] as object).some(
            (n) => pkg === "eutaxy" && n.startsWith("@eutaxy/"),
          ),
      ).toBe(true);
      const ts = readJson(join(dir, "tsconfig.json"));
      const refs = ((ts["references"] as { path: string }[] | undefined) ?? [])
        .map((r) => r.path.replace(/^\.\.\//, ""))
        .sort();
      expect(refs).toEqual([...deps].sort());
    });
  }
});

describe("undeclared imports cannot resolve", () => {
  test("an allowed, referenced import compiles", () => {
    withFixture(
      "engine",
      ["core"],
      'import { emptyLog } from "@eutaxy/core";\nexport const n = emptyLog.entries.length;\n',
      (o) => {
        expect(o.output).toBe("");
        expect(o.status).toBe(0);
      },
    );
  });

  test("a package that is not a declared dependency cannot be resolved (TS2307)", () => {
    // spec may import nothing; cloudflare is not in its dependencies, so pnpm never links it.
    withFixture(
      "spec",
      [],
      'import * as cf from "@eutaxy/cloudflare";\nexport const x = cf;\n',
      (o) => {
        expect(o.status).not.toBe(0);
        expect(o.output).toContain("TS2307");
      },
    );
  });

  test("the real workspace builds", () => {
    const o = build(root);
    expect(o.output).toBe("");
    expect(o.status).toBe(0);
  });
});
