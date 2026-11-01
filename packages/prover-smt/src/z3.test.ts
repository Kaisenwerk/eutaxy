import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerFile, platforms, toolchainDir } from "@eutaxy/prover/toolchain";
import { afterAll, describe, expect, test } from "vitest";
import { candidates, findZ3, z3Downloads, z3Version } from "./z3.ts";

const cache = mkdtempSync(join(tmpdir(), "eutaxy-z3-cache-"));
afterAll(() => rmSync(cache, { recursive: true, force: true }));
const h = {
  platform: process.platform,
  arch: process.arch,
  env: { EUTAXY_CACHE_DIR: cache },
  home: cache,
};

describe("z3Downloads", () => {
  test("one upstream file per platform, each named after the pinned version, with its checksum", () => {
    expect(z3Downloads.name).toBe("smt");
    expect(z3Downloads.version).toBe(z3Version);
    expect(Object.keys(z3Downloads.files).sort()).toEqual([...platforms].sort());
    for (const f of Object.values(z3Downloads.files)) {
      expect(f.file).toMatch(new RegExp(`^z3-${z3Version.replaceAll(".", "\\.")}-.*\\.zip$`));
      expect(f.url).toBe(
        `https://github.com/Z3Prover/z3/releases/download/z3-${z3Version}/${f.file}`,
      );
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(10_000_000);
    }
  });
});

describe("candidates and findZ3", () => {
  test("the cached solver comes before EUTAXY_Z3 and the PATH once it is installed", async () => {
    expect(candidates({ ...h, env: { ...h.env, EUTAXY_Z3: "/x/z3" } })).toEqual([
      "/x/z3",
      "z3",
      "/opt/homebrew/bin/z3",
      "/usr/local/bin/z3",
      "/usr/bin/z3",
    ]);
    const dir = toolchainDir(cache, z3Downloads);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "z3"), `#!/bin/sh\necho "Z3 version ${z3Version} - 64 bit"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(dir, markerFile),
      JSON.stringify({
        name: "smt",
        version: z3Version,
        platform: `${process.platform}-${process.arch}`,
        file: "f",
        sha256: "s",
        source: "u",
      }),
    );
    const where = candidates(h);
    expect(where[0]).toBe(join(dir, "bin", "z3"));
    expect(await findZ3(where)).toEqual({ command: join(dir, "bin", "z3"), version: z3Version });
  });
});
