/**
 * The v0.15 gate's draft half: `eutaxy draft` on each example's wrangler config gives a scenario that
 * differs from the example's own only in what the author supplies (the invariants, the drive's events,
 * the seed data, the externals' answers, the bounds and the scenario's name); and a draft, its holes
 * filled, checks through the command.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");
const examples = join(root, "examples");

type Json = Record<string, unknown>;

/** What a draft decides, from a scenario spec: the Worker, the drive's kind and target, the steps, the hosts. */
function skeletonOfSpec(spec: Json): Json {
  const drive = spec["drive"] as Json;
  return {
    worker: spec["worker"],
    drive: {
      kind: drive["kind"],
      ...(drive["kind"] === "queue" ? { queue: drive["queue"] } : {}),
      ...(drive["kind"] === "cron" ? { cron: drive["cron"] } : {}),
    },
    setup: (spec["setup"] as Json[]).map((s) => {
      const base = { kind: s["kind"], binding: s["binding"] };
      if (s["kind"] === "d1") return { ...base, schemaFile: s["schemaFile"] };
      if (s["kind"] === "workflow") return { ...base, className: s["className"] };
      if (s["kind"] === "callee") return { ...base, entry: s["entry"], config: s["config"] };
      return base;
    }),
    externals: ((spec["externals"] ?? []) as Json[]).map((e) => ({
      name: e["name"],
      host: e["host"],
    })),
  };
}

/** The draft as `eutaxy draft --json` prints it (the command's own output, as a user gets it). */
interface Draft {
  readonly worker: Json;
  readonly drive: Json;
  readonly setup: readonly Json[];
  readonly externals: readonly Json[];
  readonly notes: readonly string[];
}

function draftOf(dir: string): Draft {
  const out = execFileSync(process.execPath, [bin, "draft", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  return (JSON.parse(out) as { draft: Draft }).draft;
}

function skeletonOfDraft(d: Draft): Json {
  return skeletonOfSpec({
    worker: d.worker,
    drive: d.drive,
    setup: d.setup.map(({ sqlite: _, ...step }) => step),
    externals: d.externals,
  });
}

/** Each example's own scenario: the one file beside its wrangler config named <name>.sim.ts, not .fixed. */
const cases = readdirSync(examples, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(examples, d.name);
    const scenario = readdirSync(dir).find((f) => f.endsWith(".sim.ts") && !f.includes(".fixed."));
    return { name: d.name, dir, scenario: join(dir, scenario as string) };
  });

describe.each(cases)("eutaxy draft on examples/$name", ({ dir, scenario }) => {
  test("differs from the example's scenario only in what the author supplies", async () => {
    const spec = ((await import(pathToFileURL(scenario).href)) as { default: Json }).default;
    const draft = draftOf(dir);
    expect(skeletonOfDraft(draft)).toEqual(skeletonOfSpec(spec));
    expect(draft.notes).toEqual([]);
  });
});

describe("a draft through the command", () => {
  test("prints a scenario whose holes, once filled, find the payments example's bug", () => {
    const dir = join(examples, "payments-queue");
    const drafted = execFileSync(process.execPath, [bin, "draft"], { cwd: dir, encoding: "utf8" });
    expect(drafted).toContain('drive: queue("payments", [{ body: {} }]),');
    // Fill the holes as an author would: the messages and one invariant.
    const filled = drafted
      .replace(
        "[{ body: {} }]",
        '[{ body: { orderId: "o-1", amountCents: 100 } }, { body: { orderId: "o-2", amountCents: 200 } }]',
      )
      .replace(
        'import { d1Schema, defineScenario, queue } from "eutaxy/cloudflare";',
        'import { d1Param, d1Schema, d1Write, defineScenario, atMostOncePerKey, queue } from "eutaxy/cloudflare";',
      )
      .replace(
        "  invariants: [\n",
        '  invariants: [\n    atMostOncePerKey("recorded-once", d1Write("DB"), d1Param(0)),\n',
      );
    const file = join(dir, `drafted-${process.pid}.sim.ts`);
    const regression = file.replace(/\.sim\.ts$/, ".regression.test.ts");
    writeFileSync(file, filled);
    try {
      let stdout = "";
      try {
        execFileSync(
          process.execPath,
          [bin, "check", file, "--seed", "example", "--max-runs", "50", "--budget-ms", "60000"],
          { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (err) {
        stdout = (err as { stdout?: string }).stdout ?? "";
      }
      expect(stdout).toContain("VIOLATED  payments-queue");
      expect(stdout).toContain("Invariant recorded-once is violated");
    } finally {
      rmSync(file, { force: true });
      rmSync(regression, { force: true });
    }
  }, 180_000);
});
