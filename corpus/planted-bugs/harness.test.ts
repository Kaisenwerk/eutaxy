/**
 * Every corpus entry must be complete and internally consistent: the files
 * exist, the scenario builds, the manifest names an invariant the scenario
 * declares, and the bindings the scenario uses are configured in wrangler.
 * The verdict itself is asserted by each entry's `scenario.test.ts`, which
 * runs inside workerd under the Cloudflare Vitest plugin.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "manifest.json")))
  .map((d) => d.name);

interface Manifest {
  readonly expect: { readonly verdict: "VIOLATED"; readonly invariant: string };
  readonly fault: string;
  readonly description: string;
}

/** wrangler.jsonc is JSON with comments; strip them for the fields we read. */
function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("planted-bug corpus", () => {
  test("has at least one entry", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const name of entries) {
    describe(name, () => {
      const dir = join(here, name);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;

      // Cloudflare entries run inside workerd (wrangler.jsonc, worker.ts); AWS entries run in Node (handler.ts).
      const inWorkerd = existsSync(join(dir, "wrangler.jsonc"));
      const required = inWorkerd
        ? [
            "worker.ts",
            "wrangler.jsonc",
            "scenario.sim.ts",
            "scenario.test.ts",
            "regression.test.ts",
            "manifest.json",
            "README.md",
          ]
        : ["handler.ts", "scenario.sim.ts", "scenario.node.test.ts", "manifest.json", "README.md"];

      test("has every required file", () => {
        for (const f of required) {
          expect(existsSync(join(dir, f)), f).toBe(true);
        }
      });

      test("manifest expects a scenario verdict and names its fault", () => {
        expect(manifest.expect.verdict).toBe("VIOLATED");
        expect(manifest.expect.invariant).toMatch(/^[a-z0-9-]+$/);
        expect(manifest.fault.length).toBeGreaterThan(0);
        expect(manifest.description.length).toBeGreaterThan(0);
      });

      test("scenario builds, matches the directory, and declares the expected invariant", async () => {
        const mod = (await import(join(dir, "scenario.sim.ts"))) as { default: ScenarioSpec };
        const spec = mod.default;
        expect(spec.version).toBe(1);
        expect(spec.name).toBe(name);
        expect(spec.invariants.map((i) => i.name)).toContain(manifest.expect.invariant);
        expect(existsSync(join(dir, spec.worker.entry))).toBe(true);
        if (inWorkerd) expect(existsSync(join(dir, spec.worker.config))).toBe(true);
        for (const s of spec.setup) {
          if (s.kind === "d1") expect(existsSync(join(dir, String(s["schemaFile"])))).toBe(true);
        }
      });

      test.skipIf(!inWorkerd)(
        "the bindings the scenario uses are configured in wrangler",
        async () => {
          const mod = (await import(join(dir, "scenario.sim.ts"))) as { default: ScenarioSpec };
          const spec = mod.default;
          const wrangler = readJsonc(join(dir, spec.worker.config));
          expect(wrangler["main"]).toBe(spec.worker.entry.replace(/^\.\//, ""));
          const d1 = ((wrangler["d1_databases"] as { binding: string }[] | undefined) ?? []).map(
            (d) => d.binding,
          );
          for (const s of spec.setup) {
            if (s.kind === "d1") expect(d1).toContain(s["binding"]);
          }
          if (spec.drive.kind === "queue") {
            const consumers = (
              (wrangler["queues"] as { consumers?: { queue: string }[] } | undefined)?.consumers ??
              []
            ).map((c) => c.queue);
            expect(consumers).toContain(spec.drive["queue"]);
          }
          const targets = spec.invariants.flatMap((inv) => {
            switch (inv.kind) {
              case "atMostOncePerKey":
              case "atLeastOnce":
                return [inv.effect.target];
              case "everyRow":
                return [inv.query.target];
              case "implies":
                return [inv.when.target, inv.state.target];
              default:
                return [];
            }
          });
          for (const t of targets) {
            const m = /^D1:(.+)$/.exec(t);
            if (m) expect(d1).toContain(m[1]);
          }
        },
      );

      test("has a test that asserts the manifest's verdict", () => {
        const file = inWorkerd ? "scenario.test.ts" : "scenario.node.test.ts";
        const text = readFileSync(join(dir, file), "utf8");
        expect(text).toContain(inWorkerd ? "createCloudflarePlatform" : "createAwsPlatform");
        expect(text).toContain("manifest.expect.verdict");
      });
    });
  }
});
