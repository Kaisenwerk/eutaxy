/**
 * The published package: build it, pack it the way `pnpm publish` would, and
 * check the tarball is self-contained (no internal packages, dist entries,
 * a bin with a shebang) and that a publish dry run is accepted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const facade = join(root, "packages", "eutaxy");
const dist = join(facade, "dist");

function run(cmd: string, args: readonly string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
}

describe("published package", () => {
  test("builds a self-contained bundle with declarations and a runnable bin", () => {
    run("pnpm", ["build"], root);
    for (const f of [
      "index.mjs",
      "cloudflare.mjs",
      "cli.mjs",
      "bin.mjs",
      "index.d.mts",
      "cloudflare.d.mts",
    ]) {
      expect(existsSync(join(dist, f)), f).toBe(true);
    }
    for (const f of readdirSync(dist).filter((n) => n.endsWith(".mjs") || n.endsWith(".d.mts"))) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text, `${f} still imports an internal package`).not.toMatch(/from "@eutaxy\//);
    }
    expect(readFileSync(join(dist, "bin.mjs"), "utf8").startsWith("#!/usr/bin/env node")).toBe(
      true,
    );
    expect(run(process.execPath, [join(dist, "bin.mjs"), "help"], root)).toContain("Usage:");
    // report runs each module in a process started on the bundled chunk that holds it; the bin must
    // not be that chunk, or the process would run the command again.
    let out = "";
    try {
      run(
        process.execPath,
        [join(dist, "bin.mjs"), "report", "corpus/prover-contracts/strings", "--json"],
        root,
      );
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? ""; // exits 1: the entry plants refutations
    }
    const report = JSON.parse(out) as { specs: { kind: string }[] };
    expect(report.specs.filter((s) => s.kind === "TESTED")).toHaveLength(5);
  }, 180_000);

  test("packs with publishConfig applied: dist entries, bin, no internal dependencies", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-pack-"));
    try {
      run("pnpm", ["pack", "--pack-destination", out], facade);
      const tarball = readdirSync(out).find((n) => n.endsWith(".tgz")) as string;
      expect(tarball).toMatch(/^eutaxy-\d/);
      run("tar", ["-xzf", join(out, tarball), "-C", out], root);
      const pkg = JSON.parse(readFileSync(join(out, "package", "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(pkg["bin"]).toEqual({ eutaxy: "./dist/bin.mjs" });
      expect(pkg["keywords"]).toEqual(expect.arrayContaining(["cloudflare-workers"]));
      expect(pkg["exports"]).toEqual({
        ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
        "./cloudflare": { types: "./dist/cloudflare.d.mts", default: "./dist/cloudflare.mjs" },
        "./spec": { types: "./dist/spec.d.mts", default: "./dist/spec.mjs" },
        "./aws": { types: "./dist/aws.d.mts", default: "./dist/aws.mjs" },
      });
      // Internal packages are bundled: nothing a consumer installs may reference them.
      expect(pkg["dependencies"]).toBeUndefined();
      expect(pkg["optionalDependencies"]).toBeUndefined();
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const names = Object.keys((pkg[field] as object | undefined) ?? {});
        expect(
          names.filter((n) => n.startsWith("@eutaxy/")),
          field,
        ).toEqual([]);
      }
      expect(Object.keys(pkg["peerDependencies"] as object).sort()).toEqual([
        "@aws-sdk/client-dynamodb",
        "@aws-sdk/util-dynamodb",
        "@cloudflare/vitest-plugin",
        "@cloudflare/workers-types",
        "@smithy/smithy-client",
        "typescript",
        "vitest",
      ]);
      const files = run("tar", ["-tzf", join(out, tarball)], root).split("\n");
      expect(files).toContain("package/dist/index.mjs");
      expect(files).toContain("package/dist/bin.mjs");
      expect(files).toContain("package/README.md");
      expect(files.some((f) => f.includes("/src/"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  test("a publish dry run is accepted", () => {
    const output = run("pnpm", ["publish", "--dry-run", "--no-git-checks"], facade);
    expect(output).toMatch(/eutaxy@\d/);
  }, 180_000);
});
