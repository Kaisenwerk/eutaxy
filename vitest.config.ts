import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** One workerd project per corpus entry, so each runs with its own bindings. */
const corpora = ["corpus/planted-bugs", "corpus/differential"];
const workerdProjects = corpora.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "wrangler.jsonc")))
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
            "corpus/lemma-conformance/*.test.ts",
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
