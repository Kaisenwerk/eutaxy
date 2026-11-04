import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** One workerd project per corpus entry, so each runs with its own bindings. */
const corpora = ["corpus/planted-bugs", "corpus/differential", "corpus/gates"];
const workerdProjects = corpora.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    // An entry checked only through the command (scenario.node.test.ts, in the node project) has a
    // config the plugin alone cannot load, so it gets no workerd project.
    .filter(
      (d) =>
        d.isDirectory() &&
        existsSync(join(root, d.name, "wrangler.jsonc")) &&
        (existsSync(join(root, d.name, "scenario.test.ts")) ||
          existsSync(join(root, d.name, "regression.test.ts")) ||
          existsSync(join(root, d.name, "differential.test.ts"))),
    )
    .map((d) => ({
      plugins: [cloudflareTest({ wrangler: { configPath: `./${root}/${d.name}/wrangler.jsonc` } })],
      test: {
        name: `${root.split("/")[1]}:${d.name}`,
        include: [
          `${root}/${d.name}/scenario.test.ts`,
          `${root}/${d.name}/regression.test.ts`,
          `${root}/${d.name}/differential.test.ts`,
        ],
        testTimeout: 120_000,
      },
    })),
);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "tests/**/*.test.ts",
            ...corpora.map((root) => `${root}/harness.test.ts`),
            "corpus/prover-contracts/*.test.ts",
            // Corpus entries for platforms that run in Node (no workerd), e.g. AWS Lambda.
            ...corpora.map((root) => `${root}/*/scenario.node.test.ts`),
          ],
          testTimeout: 120_000,
        },
      },
      ...workerdProjects,
    ],
  },
});
