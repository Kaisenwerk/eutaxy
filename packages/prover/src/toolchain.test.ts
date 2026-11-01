/// <reference types="node" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  cacheDir,
  executableName,
  type Host,
  installed,
  markerFile,
  platformOf,
  type Toolchain,
  toolchainDir,
} from "./toolchain.ts";

const dir = mkdtempSync(join(tmpdir(), "eutaxy-toolchain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const linux = (env: Record<string, string> = {}): Host => ({
  platform: "linux",
  arch: "x64",
  env,
  home: "/home/u",
});

const tool: Toolchain = {
  name: "tool",
  version: "1.2.3",
  executable: "bin/tool",
  files: {
    "linux-x64": {
      file: "tool-1.2.3-linux.tar.zst",
      url: "https://example.invalid/tool-1.2.3-linux.tar.zst",
      sha256: "0".repeat(64),
      bytes: 1,
    },
  },
};

describe("cacheDir", () => {
  test("EUTAXY_CACHE_DIR wins; else the platform's user cache", () => {
    expect(cacheDir(linux({ EUTAXY_CACHE_DIR: "/c" }))).toBe("/c");
    expect(cacheDir(linux({ EUTAXY_CACHE_DIR: "rel/cache" }))).toBe(
      join(process.cwd(), "rel/cache"),
    );
    expect(cacheDir(linux({ XDG_CACHE_HOME: "rel" }))).toBe(join(process.cwd(), "rel", "eutaxy"));
    expect(cacheDir(linux())).toBe("/home/u/.cache/eutaxy");
    expect(cacheDir(linux({ XDG_CACHE_HOME: "/xdg" }))).toBe("/xdg/eutaxy");
    expect(cacheDir({ ...linux(), platform: "darwin" })).toBe("/home/u/Library/Caches/eutaxy");
    expect(cacheDir({ ...linux({ LOCALAPPDATA: "C:\\L" }), platform: "win32" })).toBe(
      join("C:\\L", "eutaxy", "Cache"),
    );
    expect(cacheDir({ ...linux(), platform: "win32" })).toBe(
      join("/home/u", "AppData", "Local", "eutaxy", "Cache"),
    );
  });
});

describe("platformOf and executableName", () => {
  test("the platforms with a release; .exe on Windows", () => {
    expect(platformOf(linux())).toBe("linux-x64");
    expect(platformOf({ ...linux(), platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(platformOf({ ...linux(), platform: "freebsd" })).toBeUndefined();
    expect(platformOf({ ...linux(), platform: "win32", arch: "arm64" })).toBeUndefined();
    expect(executableName(tool, linux())).toBe("bin/tool");
    expect(executableName(tool, { ...linux(), platform: "win32" })).toBe("bin/tool.exe");
  });
});

describe("installed", () => {
  test("only when the marker and the executable are both there and the marker names this release for this platform", () => {
    const h = linux({ EUTAXY_CACHE_DIR: dir });
    const where = toolchainDir(dir, tool);
    expect(where).toBe(join(dir, "toolchains", "tool", "1.2.3"));
    expect(installed(tool, h)).toBeUndefined();
    mkdirSync(join(where, "bin"), { recursive: true });
    writeFileSync(join(where, "bin", "tool"), "");
    expect(installed(tool, h)).toBeUndefined();
    const marker = {
      name: "tool",
      version: "1.2.3",
      platform: "linux-x64",
      file: "tool-1.2.3-linux.tar.zst",
      sha256: "0".repeat(64),
      source: "https://example.invalid/tool-1.2.3-linux.tar.zst",
    };
    writeFileSync(join(where, markerFile), JSON.stringify(marker));
    expect(installed(tool, h)).toEqual({
      dir: where,
      executable: join(where, "bin", "tool"),
      marker,
    });
    writeFileSync(join(where, markerFile), "{not json");
    expect(installed(tool, h)).toBeUndefined();
    writeFileSync(join(where, markerFile), JSON.stringify({ ...marker, platform: "darwin-arm64" }));
    expect(installed(tool, h)).toBeUndefined();
    writeFileSync(join(where, markerFile), JSON.stringify({ ...marker, version: "1.2.4" }));
    expect(installed(tool, h)).toBeUndefined();
    writeFileSync(join(where, markerFile), JSON.stringify({ name: "tool", version: "1.2.3" }));
    expect(installed(tool, h)).toBeUndefined();
  });
});
