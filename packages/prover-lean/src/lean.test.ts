import { describe, expect, test } from "vitest";
import { diagnostics, jsonDiagnostics } from "./lean.ts";

describe("diagnostics", () => {
  test("file:line:col: severity: message, continuation lines kept with their diagnostic", () => {
    const out = diagnostics(
      [
        "Eutaxy.lean:44:25: error: omega could not prove the goal:",
        "a possible counterexample may satisfy the constraints",
        "  a ≥ 1",
        "Eutaxy.lean:50:2: warning: declaration uses 'sorry'",
        "/tmp/x/Eutaxy.lean:3:0: info: fine",
        "",
      ].join("\n"),
    );
    expect(out).toEqual([
      {
        line: 44,
        column: 25,
        severity: "error",
        message:
          "omega could not prove the goal:\na possible counterexample may satisfy the constraints\n  a ≥ 1",
      },
      { line: 50, column: 2, severity: "warning", message: "declaration uses 'sorry'" },
      { line: 3, column: 0, severity: "info", message: "fine" },
    ]);
    expect(diagnostics("")).toEqual([]);
  });
});

describe("jsonDiagnostics", () => {
  test("Lean's messages with their positions; anything else written is not one", () => {
    const out = [
      '{"data":"unsolved goals","pos":{"line":4,"column":19},"severity":"error"}',
      "'t' does not depend on any axioms",
      `{"data":"'t' depends on axioms: [propext]","pos":{"line":9,"column":0},"severity":"information"}`,
      "{not json",
    ].join("\n");
    expect(jsonDiagnostics(out)).toEqual([
      { line: 4, column: 19, severity: "error", message: "unsolved goals" },
      { line: 9, column: 0, severity: "info", message: "'t' depends on axioms: [propext]" },
    ]);
  });
});

describe("leanDownloads", () => {
  test("one upstream file per platform, each named after the pinned version, with its checksum", async () => {
    const { leanDownloads, leanVersion } = await import("./lean.ts");
    const { platforms } = await import("@eutaxy/prover/toolchain");
    expect(leanDownloads.name).toBe("lean");
    expect(leanDownloads.version).toBe(leanVersion);
    expect(Object.keys(leanDownloads.files).sort()).toEqual([...platforms].sort());
    for (const f of Object.values(leanDownloads.files)) {
      expect(f.file).toContain(`lean-${leanVersion}-`);
      expect(f.url).toBe(
        `https://github.com/leanprover/lean4/releases/download/v${leanVersion}/${f.file}`,
      );
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(100_000_000);
    }
  });
});

describe("findLean", () => {
  test("the cached toolchain comes first when it answers as the pinned Lean, and is named when it does not", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findLean, leanDownloads, leanVersion } = await import("./lean.ts");
    const { markerFile, toolchainDir } = await import("@eutaxy/prover/toolchain");
    const cache = mkdtempSync(join(tmpdir(), "eutaxy-lean-cache-"));
    try {
      const h = {
        platform: process.platform,
        arch: process.arch,
        env: { EUTAXY_CACHE_DIR: cache },
        home: cache,
      };
      const dir = toolchainDir(cache, leanDownloads);
      mkdirSync(join(dir, "bin"), { recursive: true });
      const fake = (version: string) =>
        writeFileSync(
          join(dir, "bin", "lean"),
          `#!/bin/sh\necho "Lean (version ${version}, x86_64-unknown-linux-gnu, commit 0, Release)"\n`,
          { mode: 0o755 },
        );
      fake(leanVersion);
      writeFileSync(
        join(dir, markerFile),
        JSON.stringify({
          name: "lean",
          version: leanVersion,
          platform: `${process.platform}-${process.arch}`,
          file: "f",
          sha256: "s",
          source: "u",
        }),
      );
      expect(await findLean(h)).toEqual({
        command: join(dir, "bin", "lean"),
        args: [],
        version: leanVersion,
      });
      fake("4.0.0");
      const found = await findLean(h);
      // Whatever else this machine has, the cached toolchain is reported by its directory.
      if ("unavailable" in found)
        expect(found.unavailable).toContain(
          `the toolchain in ${dir} did not answer as Lean ${leanVersion}`,
        );
      else expect(found.command).not.toBe(join(dir, "bin", "lean"));
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
