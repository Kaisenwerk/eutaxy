import { existsSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * workerd logs every rejection nothing handled as an "uncaught exception",
 * and the corpora cause thousands of them on purpose: a crash inside an
 * object, an injected fault, a late attempt fenced off. The Cloudflare
 * plugin prints each one itself (to stdout or stderr by its level) and
 * takes no handler of ours, so in `vitest run` they are held back where it
 * writes them and printed at exit, when every one has come through
 * workerd's pipe (most arrive after the run's summary): a run that passed
 * prints how many there were, a run that failed prints them all.
 * `EUTAXY_TEST_LOGS=all` prints them as they come, as watch mode always does.
 */
function holdWorkerdExceptions(): void {
  if (!process.argv.includes("run") || process.env["EUTAXY_TEST_LOGS"] === "all") return;
  const held: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk !== "string" || !chunk.startsWith("uncaught exception"))
        return write(chunk, ...rest);
      held.push(chunk);
      (rest.find((r) => typeof r === "function") as (() => void) | undefined)?.();
      return true;
    }) as typeof stream.write;
  }
  // One listener more than the runner's own, which reach Node's default limit.
  process.setMaxListeners(process.getMaxListeners() + 1);
  process.on("exit", (code) => {
    if (held.length === 0) return;
    if (code === 0)
      writeAll(
        1,
        `workerd logged ${held.length} uncaught exceptions; the run passed, so they are not printed (EUTAXY_TEST_LOGS=all prints them)\n`,
      );
    else
      writeAll(
        2,
        `workerd logged ${held.length} uncaught exceptions during this run:\n${held.join("")}`,
      );
  });
}

/**
 * Write all of `text` synchronously, as an exit handler must: a pipe takes
 * a write only in part when it is full, and refuses it (EAGAIN) when it is
 * non-blocking and full, so the rest is written until none is left.
 */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let at = 0;
  while (at < bytes.length) {
    try {
      at += writeSync(fd, bytes, at);
    } catch (err) {
      if ((err as { code?: string }).code !== "EAGAIN") throw err;
    }
  }
}
holdWorkerdExceptions();

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
