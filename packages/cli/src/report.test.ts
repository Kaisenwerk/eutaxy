import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { runReport } from "./report.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Under the planted-bug corpus, where `eutaxy/spec` resolves and no other test walks for spec files;
// .probe-* is gitignored.
const scratch = join(root, "corpus/planted-bugs", `.probe-report-unit-${process.pid}`);
mkdirSync(scratch, { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function report(
  dir: string,
  extra: { seed?: string; provers?: readonly string[]; json?: boolean; budgetMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runReport({
    cwd: root,
    dir,
    json: extra.json ?? true,
    ...(extra.seed === undefined ? {} : { seed: extra.seed }),
    ...(extra.provers === undefined ? {} : { provers: extra.provers }),
    ...(extra.budgetMs === undefined ? {} : { moduleBudgetMs: extra.budgetMs }),
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

interface Json {
  schemaVersion: number;
  specs: { module: string; function: string; property: string; kind: string; reason?: string }[];
}

describe("eutaxy report", () => {
  test("every spec file under the directory through TESTED, keyed by its path there", async () => {
    const r = await report("corpus/prover-contracts/strings");
    // The entry plants refutations (a claim false on NaN), so the report fails.
    expect(r.code, r.stderr).toBe(1);
    const json = JSON.parse(r.stdout) as Json;
    expect(json.schemaVersion).toBe(1);
    expect(new Set(json.specs.map((s) => s.module))).toEqual(new Set(["./domain.ts"]));
    expect(json.specs.map((s) => [s.function, s.property, s.kind])).toEqual([
      ["decideAccess", "sendCodeIff", "TESTED"],
      ["decideAccess", "twoOutcomes", "TESTED"],
      ["decideAccess", "decideAccessTotal", "UNKNOWN"],
      ["networkKey", "neverEmpty", "TESTED"],
      ["sameNetwork", "distinctNetworks", "TESTED"],
      ["tag", "kindOfSign", "REFUTED"],
      ["tag", "codeKept", "REFUTED"],
      ["label", "escapes", "TESTED"],
    ]);
    // No scenario ran: nothing claims the simulator passed or missed an input.
    expect(r.stdout).not.toContain("never called");
  });

  test("the same seed gives byte-identical output; the seed is what changes it", async () => {
    const a = await report("corpus/prover-contracts", { seed: "s" });
    const b = await report("corpus/prover-contracts", { seed: "s" });
    // Known gap: a counterexample that overflows the stack shrinks to the smallest input that still
    // overflows, and that depends on how far V8 has optimized the recursion, not on the seed. Its
    // verdict and error are stable; only the shrunk value is masked here.
    const overflow = /"value":"\d+"\}\],"error":"RangeError: Maximum call stack size exceeded"/g;
    const masked = (t: string) =>
      t.replace(overflow, '"value":"…"}],"error":"RangeError: Maximum call stack size exceeded"');
    expect(a.stdout).toMatch(overflow);
    expect(masked(a.stdout)).toBe(masked(b.stdout));
    const modules = new Set((JSON.parse(a.stdout) as Json).specs.map((s) => s.module));
    expect(modules.has("./strings/domain.ts")).toBe(true);
    expect(modules.has("./refund-fixed/domain.ts")).toBe(true);
    const c = await report("corpus/prover-contracts", { seed: "t" });
    expect(c.stdout).not.toBe(a.stdout);
  });

  test("text: grouped by module with a closing count", async () => {
    const r = await report("corpus/prover-contracts/strings", { json: false });
    expect(r.stdout).toContain("\n./domain.ts\n  TESTED   decideAccess sendCodeIff:");
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(
      "8 properties in 1 module: 5 TESTED, 2 REFUTED, 1 UNKNOWN",
    );
  });

  test("a module Node cannot load leaves its properties UNKNOWN, and the report goes on", async () => {
    const dir = join(scratch, "workerd-only");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "domain.ts"),
      'import { DurableObject } from "cloudflare:workers";\nexport const base = DurableObject;\nexport function f(x: number): number { return x; }\n',
    );
    writeFileSync(
      join(dir, "domain.props.ts"),
      'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const same = forall(f, { ensures: (x) => f(x) === x });\n',
    );
    const r = await report(dir);
    expect(r.code, r.stderr).toBe(0);
    const [only] = (JSON.parse(r.stdout) as Json).specs;
    expect(only).toMatchObject({ property: "same", kind: "UNKNOWN", cause: "unavailable" });
    expect(only?.reason).toContain("did not load in Node");
    expect(only?.reason).toContain("cloudflare:");
  });

  test("a spec file may import its module as ./domain, ./domain.js or ./domain.ts", async () => {
    for (const spelling of ["./domain", "./domain.js", "./domain.ts"]) {
      const dir = join(scratch, `spelling-${spelling.length}`);
      mkdirSync(join(dir, "lib"), { recursive: true });
      // The module's own imports may use the same spellings: a NodeNext project writes .js.
      writeFileSync(
        join(dir, "lib", "not.ts"),
        "export const not = (x: boolean): boolean => !x;\n",
      );
      writeFileSync(
        join(dir, "domain.ts"),
        `import { not } from "./lib/not${spelling.slice("./domain".length)}";\nexport function f(x: boolean): boolean {\n  return not(x);\n}\n`,
      );
      writeFileSync(
        join(dir, "domain.props.ts"),
        `import { forall } from "eutaxy/spec";\nimport { f } from "${spelling}";\nexport const same = forall(f, { ensures: (x) => f(x) === x });\n`,
      );
      const r = await report(dir);
      expect(r.code, `${spelling}: ${r.stdout}`).toBe(1);
      expect((JSON.parse(r.stdout) as Json).specs[0]?.kind).toBe("REFUTED");
    }
  });

  test("a module whose property never returns ends at the budget; the others are still reported", async () => {
    const dir = join(scratch, "hangs");
    for (const [sub, body] of [
      ["loops", "for (;;) {}"],
      ["fine", "return x;"],
    ] as const) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(
        join(dir, sub, "domain.ts"),
        `export function f(x: boolean): boolean {\n  ${body}\n}\n`,
      );
      writeFileSync(
        join(dir, sub, "domain.props.ts"),
        'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const same = forall(f, { ensures: (x) => f(x) === x });\n',
      );
    }
    const r = await report(dir, { budgetMs: 2000 });
    expect(r.code, r.stderr).toBe(0);
    const specs = (JSON.parse(r.stdout) as Json).specs;
    expect(specs.map((s) => [s.module, s.kind])).toEqual([
      ["./fine/domain.ts", "TESTED"],
      ["./loops/domain.ts", "UNKNOWN"],
    ]);
    expect(specs[1]).toMatchObject({ cause: "gave_up" });
    expect(specs[1]?.reason).toContain("did not finish within 2000 ms");
  });

  test("a module's own output goes to stderr, and its state starts fresh each run", async () => {
    const dir = join(scratch, "noisy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "domain.ts"),
      'let calls = 0;\nconsole.log("loaded");\nsetTimeout(() => console.log("later"), 0);\nexport function f(x: boolean): boolean {\n  calls++;\n  return calls < 2 ? x : !x;\n}\n',
    );
    writeFileSync(
      join(dir, "domain.props.ts"),
      'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const same = forall(f, { ensures: (x) => f(x) === x });\n',
    );
    const a = await report(dir);
    const b = await report(dir);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stderr).toContain("loaded");
    expect((JSON.parse(a.stdout) as Json).specs[0]?.kind).toBe("REFUTED");
  });

  test("errors exit 3: no spec files, a spec file without its module, an unknown engine", async () => {
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const none = await report(empty);
    expect(none.code).toBe(3);
    expect(none.stderr).toContain("no spec files");
    const orphan = join(scratch, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "gone.props.ts"), "export {};\n");
    const lone = await report(orphan);
    expect(lone.code).toBe(3);
    expect(lone.stderr).toContain("./gone.ts:1: gone.props.ts has no module gone.ts beside it");
    const unknown = await report("corpus/prover-contracts/strings", { provers: ["coq"] });
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain("unknown prover coq; known: lean, smt");
    expect((await report(join(scratch, "missing"))).code).toBe(3);
  });
});
