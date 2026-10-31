/**
 * The R2 model in Node, over a fake bucket whose versions and upload times
 * change from run to run as the real store's do: each call is one effect,
 * a body is read inside its get, stand-ins keep the trace byte-identical,
 * and setup empties, seeds and snapshots the bucket. The corpus checks the
 * real Miniflare bucket.
 */
import {
  atMostOncePerKey,
  checkInvariants,
  type EffectRecord,
  type JsonValue,
  type ScenarioSpec,
} from "@eutaxy/core";
import { Run, replayChooser, runOnce, virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { FakeR2 } from "./fake-r2.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import {
  defineScenario,
  http,
  type R2Setup,
  r2Bucket,
  r2Op,
  r2Rows,
  references,
} from "./scenario.ts";

type Step =
  | { op: "put"; key: string; text: string; onlyIf?: R2Conditional; meta?: Record<string, string> }
  | { op: "get"; key: string; onlyIf?: R2Conditional; twice?: boolean; ssecKey?: string }
  | { op: "head"; key: string }
  | { op: "list"; prefix?: string }
  | { op: "delete"; keys: string[] }
  | { op: "multipart"; key: string }
  | { op: "copy"; from: string; to: string }
  | { op: "dated"; key: string };

/** What the Worker saw, per step. */
let seen: unknown[] = [];

const described = (o: R2Object | null) =>
  o === null
    ? null
    : { key: o.key, version: o.version, uploaded: o.uploaded.getTime() - virtualEpoch };

const worker: WorkerHandler = {
  async fetch(request, env) {
    const bucket = (env as { BUCKET: R2Bucket }).BUCKET;
    for (const s of (await request.json()) as Step[]) {
      if (s.op === "put") {
        const o = await bucket.put(s.key, s.text, {
          ...(s.onlyIf ? { onlyIf: s.onlyIf } : {}),
          ...(s.meta ? { customMetadata: s.meta } : {}),
        });
        seen.push(described(o));
      } else if (s.op === "get") {
        const o = await bucket.get(s.key, {
          ...(s.onlyIf ? { onlyIf: s.onlyIf } : {}),
          ...(s.ssecKey ? { ssecKey: s.ssecKey } : {}),
        });
        if (o === null || !("body" in o)) {
          seen.push({ ...described(o), body: false });
          continue;
        }
        const text = await o.text();
        let again = "";
        if (s.twice)
          try {
            await o.text();
          } catch (err) {
            again = String(err);
          }
        seen.push({ ...described(o), text, again, used: o.bodyUsed });
      } else if (s.op === "head") seen.push(described(await bucket.head(s.key)));
      else if (s.op === "list")
        seen.push(
          (await bucket.list(s.prefix === undefined ? {} : { prefix: s.prefix })).objects.map(
            described,
          ),
        );
      else if (s.op === "delete") await bucket.delete(s.keys);
      else if (s.op === "copy") {
        const o = await bucket.get(s.from);
        if (o !== null && "body" in o) seen.push(described(await bucket.put(s.to, o.body)));
      } else if (s.op === "dated")
        seen.push(
          described(await bucket.head(s.key)) &&
            (await bucket.get(s.key, { onlyIf: { uploadedBefore: new Date() } })) !== null,
        );
      else await bucket.createMultipartUpload(s.key);
    }
    return new Response("ok");
  },
};

function scenario(
  steps: Step[],
  setup: R2Setup[] = [r2Bucket("BUCKET", { "seed.txt": "from the seed" })],
): ScenarioSpec {
  return defineScenario({
    name: "r2",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: http([{ path: "/", body: steps as unknown as JsonValue }], { retries: 0 }),
    setup,
    invariants: [
      { kind: "unique", name: "one-object-per-key", query: r2Rows("BUCKET"), path: "key" },
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, maxConcurrentInvocations: 1 },
  });
}

async function run(
  spec: ScenarioSpec,
  bucket = new FakeR2(),
  faults: Run["schedule"]["faults"] = [],
) {
  seen = [];
  const r = new Run({
    chooser: replayChooser({ seed: 1, faults: [...faults] }),
    bounds: spec.bounds,
  });
  await runOnce(
    spec,
    createCloudflarePlatform({ env: { BUCKET: bucket }, handler: worker, schemas: {} }),
    r,
  );
  return { r, bucket, seen };
}

const effects = (r: Run, kind: EffectRecord["kind"]) =>
  r.log.entries.filter((e) => e.kind === kind && e.target === "R2:BUCKET");
const objects = (r: Run) => {
  const snap = [...r.log.entries]
    .reverse()
    .find((e) => e.kind === "snapshot" && e.target === "R2:BUCKET");
  if (!snap) throw new Error("no R2 snapshot");
  return (snap.payload as { tables: { objects: { key: string; text?: string }[] } }).tables.objects;
};
const fault = (
  ordinal: number,
  f: "crash_before" | "crash_after" | "ambiguous" | "error",
  op: string,
) => ({
  invocation: "req-1#1",
  ordinal,
  fault: f,
  target: "R2:BUCKET",
  op,
});

describe("R2 bucket", () => {
  const steps: Step[] = [
    { op: "put", key: "a.txt", text: "alpha" },
    { op: "get", key: "a.txt" },
    { op: "get", key: "seed.txt" },
    { op: "list" },
  ];

  test("versions and upload times are stand-ins, so the trace repeats", async () => {
    const first = await run(scenario(steps));
    const second = await run(scenario(steps));
    expect(JSON.stringify(second.r.log.entries)).toBe(JSON.stringify(first.r.log.entries));
    expect(second.seen).toEqual(first.seen);
    const v = (n: number) => n.toString(16).padStart(32, "0");
    // Each version counts from 1 as the run first sees it, at the virtual time it does.
    expect(first.seen.slice(0, 3)).toEqual([
      { key: "a.txt", version: v(1), uploaded: 0 },
      { key: "a.txt", version: v(1), uploaded: 0, text: "alpha", again: "", used: true },
      { key: "seed.txt", version: v(2), uploaded: 2, text: "from the seed", again: "", used: true },
    ]);
    expect(effects(first.r, "result").map((e) => e.op)).toEqual(["put", "get", "get", "list"]);
  });

  test("a get reads its body inside the effect, and the body reads once", async () => {
    const { bucket, seen } = await run(scenario([{ op: "get", key: "seed.txt", twice: true }]));
    expect(bucket.bodiesGiven).toBe(2); // the get, and the snapshot after the run
    expect(bucket.bodiesRead).toBe(2);
    expect(seen[0]).toMatchObject({
      text: "from the seed",
      again: expect.stringContaining("already been used"),
    });
  });

  test("a failed precondition stores nothing, and a conditional get answers without a body", async () => {
    const { r, seen } = await run(
      scenario([
        { op: "put", key: "seed.txt", text: "lost", onlyIf: { etagMatches: "nope" } },
        { op: "get", key: "seed.txt", onlyIf: { etagMatches: "nope" } },
      ]),
    );
    expect(seen).toEqual([null, expect.objectContaining({ key: "seed.txt", body: false })]);
    expect(effects(r, "result").map((e) => (e.payload as { result: unknown }).result)).toEqual([
      { stored: false },
      expect.objectContaining({ found: true, body: false }),
    ]);
    expect(objects(r).map((o) => o.text)).toEqual(["from the seed"]);
  });

  test("a crash before a put stores nothing; after it, or an ambiguous put, the object is there", async () => {
    const put: Step[] = [{ op: "put", key: "a.txt", text: "alpha" }];
    const before = await run(scenario(put), new FakeR2(), [fault(0, "crash_before", "put")]);
    expect(objects(before.r).map((o) => o.key)).toEqual(["seed.txt"]);
    for (const f of ["crash_after", "ambiguous"] as const) {
      const after = await run(scenario(put), new FakeR2(), [fault(0, f, "put")]);
      expect(after.r.faultsInjected).toBe(1);
      expect(after.seen).toEqual([]);
      expect(objects(after.r).map((o) => o.key)).toEqual(["a.txt", "seed.txt"]);
    }
  });

  test("reads take every fault but ambiguous", async () => {
    const get: Step[] = [{ op: "get", key: "seed.txt" }];
    const ambiguous = await run(scenario(get), new FakeR2(), [fault(0, "ambiguous", "get")]);
    expect(ambiguous.r.faultsInjected).toBe(0);
    const error = await run(scenario(get), new FakeR2(), [fault(0, "error", "get")]);
    expect(error.r.faultsInjected).toBe(1);
    expect(error.seen).toEqual([]);
  });

  test("setup empties the bucket, through every page, and seeds it; the snapshot keeps small text", async () => {
    const bucket = new FakeR2();
    for (let i = 0; i < 1500; i++) await bucket.put(`old/${i}`, "x");
    await bucket.put("bin", new Uint8Array([0xff, 0xfe]));
    const seeds = r2Bucket("BUCKET", {
      "b.txt": {
        value: "bee",
        customMetadata: { owner: "u1" },
        httpMetadata: { contentType: "text/plain" },
      },
      "big.txt": "y".repeat(5000),
    });
    const { r } = await run(scenario([{ op: "list", prefix: "old/" }], [seeds]), bucket);
    expect(seen).toEqual([[]]);
    expect(objects(r)).toEqual([
      expect.objectContaining({
        key: "b.txt",
        size: 3,
        text: "bee",
        customMetadata: { owner: "u1" },
        httpMetadata: { contentType: "text/plain" },
      }),
      expect.not.objectContaining({ text: expect.anything() }),
    ]);
    expect(objects(r)[1]).toMatchObject({ key: "big.txt", size: 5000 });
  });

  test("r2Op selects completed operations, and references joins objects to rows", async () => {
    const { r } = await run(
      scenario([
        { op: "put", key: "b.txt", text: "y", onlyIf: { etagMatches: "nope" } },
        { op: "put", key: "b.txt", text: "x", onlyIf: { etagMatches: "nope" } },
        { op: "put", key: "a.txt", text: "one" },
        { op: "put", key: "a.txt", text: "two" },
      ]),
    );
    const violations = checkInvariants(r.log, [
      atMostOncePerKey("one-put-per-key", r2Op("BUCKET"), "args.key"),
      references(
        "seed-named",
        r2Rows("BUCKET"),
        "key",
        r2Rows("BUCKET", [{ column: "key", op: "eq", value: "seed.txt" }]),
        "key",
      ),
    ]);
    expect(violations.map((v) => [v.invariant, v.keys])).toEqual([
      // b.txt's two puts stored nothing (their onlyIf failed), so neither is selected.
      ["one-put-per-key", ['"a.txt"']],
      ["seed-named", ['"a.txt"']],
    ]);
  });

  test("the body's stream and its methods share one consumption, as a real body's do", async () => {
    const body = async (use: (o: R2ObjectBody) => Promise<unknown>) => {
      let out: unknown;
      const handler: WorkerHandler = {
        async fetch(_r, env) {
          const o = (await (env as { BUCKET: R2Bucket }).BUCKET.get("seed.txt")) as R2ObjectBody;
          try {
            out = await use(o);
          } catch (err) {
            out = `threw ${String(err)}`;
          }
          return new Response("ok");
        },
      };
      const spec = scenario([]);
      await runOnce(
        spec,
        createCloudflarePlatform({ env: { BUCKET: new FakeR2() }, handler, schemas: {} }),
        new Run({
          chooser: replayChooser({ seed: 1, faults: [] }),
          bounds: spec.bounds,
        }),
      );
      return out;
    };
    expect(await body(async (o) => [o.bodyUsed, await o.text(), o.bodyUsed])).toEqual([
      false,
      "from the seed",
      true,
    ]);
    expect(
      await body(async (o) => {
        await o.body.cancel();
        return [o.bodyUsed, await o.text()];
      }),
    ).toMatch(/^threw TypeError/);
    expect(
      await body(async (o) => {
        o.body.getReader();
        return o.text();
      }),
    ).toMatch(/^threw TypeError/);
    expect(
      await body(async (o) => new TextDecoder().decode((await o.body.getReader().read()).value)),
    ).toBe("from the seed");
  });

  test("a get's trace keeps its conditions and range, never its encryption key", async () => {
    const { r } = await run(
      scenario([
        {
          op: "get",
          key: "seed.txt",
          onlyIf: { etagDoesNotMatch: "x" },
          ssecKey: "secret-key-bytes",
        },
      ]),
    );
    const args = effects(r, "call").map((e) => (e.payload as { args: unknown }).args);
    expect(args).toEqual([{ key: "seed.txt", onlyIf: { etagDoesNotMatch: "x" } }]);
    expect(JSON.stringify(r.log.entries)).not.toContain("secret-key-bytes");
  });

  test("a body handed to put is copied, though its stream has no known length", async () => {
    const { r, seen } = await run(scenario([{ op: "copy", from: "seed.txt", to: "copy.txt" }]));
    expect(r.unsupportedReasons).toEqual([]);
    expect(seen).toEqual([expect.objectContaining({ key: "copy.txt" })]);
    expect(objects(r).map((o) => [o.key, o.text])).toEqual([
      ["copy.txt", "from the seed"],
      ["seed.txt", "from the seed"],
    ]);
  });

  test("conditions on the upload time make the run UNSUPPORTED: the store compares its real time", async () => {
    const { r } = await run(scenario([{ op: "dated", key: "seed.txt" }]));
    expect(r.unsupportedReasons.join()).toContain("conditions on the upload time are not modelled");
  });

  test("a binding without a setup step, and a multipart upload, make the run UNSUPPORTED", async () => {
    const bare = await run(scenario([{ op: "head", key: "x" }], []));
    expect(bare.r.unsupportedReasons.join()).toContain("needs an r2Bucket() setup step");
    const multipart = await run(scenario([{ op: "multipart", key: "big" }]));
    expect(multipart.r.unsupportedReasons.join()).toContain(
      "createMultipartUpload() is not modelled",
    );
  });
});
