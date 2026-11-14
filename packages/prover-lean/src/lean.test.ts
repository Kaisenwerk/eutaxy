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

describe("elanDownloads and leanDigests", () => {
  test("one pinned elan installer per platform, each listing the one file taken from it, and a toolchain digest per platform", async () => {
    const { elanDownloads, elanVersion, leanDigests } = await import("./elan.ts");
    const { platforms } = await import("@eutaxy/prover/toolchain");
    expect(elanDownloads.name).toBe("elan");
    expect(elanDownloads.version).toBe(elanVersion);
    expect(Object.keys(elanDownloads.files).sort()).toEqual([...platforms].sort());
    for (const [platform, f] of Object.entries(elanDownloads.files)) {
      expect(f.url).toBe(
        `https://github.com/leanprover/elan/releases/download/v${elanVersion}/${f.file}`,
      );
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(1_000_000);
      const installer = platform === "win32-x64" ? "elan-init.exe" : "elan-init";
      expect(f.file.endsWith(platform === "win32-x64" ? ".zip" : ".tar.gz")).toBe(true);
      expect(f.entries).toEqual({ [installer]: installer });
    }
    expect(Object.keys(leanDigests).sort()).toEqual([...platforms].sort());
    for (const d of Object.values(leanDigests)) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toolchainDigest", () => {
  test("covers every file's content and path and every link's target, and nothing else", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { toolchainDigest } = await import("./elan.ts");
    const dir = mkdtempSync(join(tmpdir(), "eutaxy-digest-"));
    try {
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "empty"));
      writeFileSync(join(dir, "bin", "lean"), "lean");
      writeFileSync(join(dir, "a.txt"), "a");
      symlinkSync("bin/lean", join(dir, "link"));
      const sha = (t: string) => createHash("sha256").update(t).digest("hex");
      const expected = sha(`${sha("a")}  a.txt\n${sha("lean")}  bin/lean\n-> bin/lean  link\n`);
      expect(toolchainDigest(dir)).toEqual({ digest: expected, files: 2, bytes: 5 });
      writeFileSync(join(dir, "a.txt"), "b");
      expect(toolchainDigest(dir).digest).not.toBe(expected);
      writeFileSync(join(dir, "a.txt"), "a");
      rmSync(join(dir, "link"));
      symlinkSync("a.txt", join(dir, "link"));
      expect(toolchainDigest(dir).digest).not.toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findLean", () => {
  test("Eutaxy's own elan in the cache comes first, run with its ELAN_HOME, and is passed over when it lacks the toolchain", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findLean, leanToolchain, leanVersion } = await import("./lean.ts");
    const { elanHome } = await import("./elan.ts");
    const cache = mkdtempSync(join(tmpdir(), "eutaxy-lean-cache-"));
    try {
      const h = {
        platform: process.platform,
        arch: process.arch,
        env: { EUTAXY_CACHE_DIR: cache },
        home: cache,
      };
      const home = elanHome(h);
      const elan = join(home, "bin", "elan");
      mkdirSync(join(home, "bin"), { recursive: true });
      // Lists the toolchain only when run with this ELAN_HOME, as a real elan would.
      const fake = (listed: string) =>
        writeFileSync(
          elan,
          `#!/bin/sh\n[ "$ELAN_HOME" = "${home}" ] || exit 7\n[ "$1 $2" = "toolchain list" ] && echo "${listed}"\nexit 0\n`,
          { mode: 0o755 },
        );
      fake(`${leanToolchain} (default)`);
      expect(await findLean(h)).toEqual({
        command: elan,
        args: ["run", leanToolchain, "lean"],
        version: leanVersion,
        env: { ELAN_HOME: home },
      });
      fake("leanprover/lean4:v4.0.0");
      const found = await findLean(h);
      // Whatever else this machine has, the cache's elan without the toolchain is not used.
      if ("unavailable" in found) expect(found.unavailable).toContain(`elan (${elan}) has no`);
      else expect(found.command).not.toBe(elan);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("findLean with an elan that lacks the toolchain", () => {
  test("reports it unavailable and never runs a bare lean, which may be elan's proxy that downloads a toolchain", async () => {
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findLean, leanToolchain } = await import("./lean.ts");
    const dir = mkdtempSync(join(tmpdir(), "eutaxy-lean-proxy-"));
    try {
      const elan = join(dir, "elan");
      writeFileSync(elan, "#!/bin/sh\necho leanprover/lean4:v4.0.0\n", { mode: 0o755 });
      const marker = join(dir, "proxy-ran");
      const proxy = join(dir, "lean");
      writeFileSync(
        proxy,
        `#!/bin/sh\ntouch "${marker}"\necho "Lean (version 4.35.0, x, commit 0, Release)"\n`,
        {
          mode: 0o755,
        },
      );
      const h = { platform: process.platform, arch: process.arch, env: {}, home: dir };
      const found = await findLean(h, [{ command: elan }], [proxy]);
      expect(found).toEqual({
        unavailable: expect.stringContaining(`elan (${elan}) has no ${leanToolchain}`),
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
