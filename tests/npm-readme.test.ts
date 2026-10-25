/**
 * The npm page shows the repository README, not the facade's package note,
 * and every link on it resolves on GitHub at the released tag.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { npmReadme, repositoryUrl } from "../scripts/npm-readme.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "https://github.com/Kaisenwerk/eutaxy";

describe("npm README", () => {
  test("relative links point at the repository at the given ref; others are kept", () => {
    const md = [
      "[design](docs/design.md) [example](./examples/payments-queue)",
      "[site](https://example.com) [mail](mailto:a@b.c) [anchor](#verdicts) [abs](/x)",
    ].join("\n");
    expect(npmReadme(md, `${repo}.git`, "v1.2.3")).toBe(
      [
        `[design](${repo}/blob/v1.2.3/docs/design.md) [example](${repo}/blob/v1.2.3/examples/payments-queue)`,
        "[site](https://example.com) [mail](mailto:a@b.c) [anchor](#verdicts) [abs](/x)",
      ].join("\n"),
    );
  });

  test("the repository URL comes from the published package's manifest", () => {
    expect(repositoryUrl()).toBe(`${repo}.git`);
  });

  test("the script writes the repository README with no relative links left", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-readme-"));
    try {
      const file = join(out, "README.md");
      execFileSync(process.execPath, [join(root, "scripts", "npm-readme.ts"), "v0.0.0", file]);
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("# Eutaxy\n")).toBe(true);
      expect(text).toContain(`](${repo}/blob/v0.0.0/docs/design.md)`);
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.filter((t) => !t.startsWith("https://") && !t.startsWith("#"))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
