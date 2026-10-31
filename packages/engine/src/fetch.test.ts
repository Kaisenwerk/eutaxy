import type { ExternalDecl, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { explore, replay } from "./explore.ts";
import { buggyConsumer, createFakePlatform } from "./fake-platform.ts";
import { createScriptedFetch, findResponse, hostMatches, withoutNetwork } from "./fetch.ts";
import { Run } from "./run.ts";

const payments: ExternalDecl = {
  name: "payments",
  host: "api.payments.example",
  guarantees: { dedupeBy: "Idempotency-Key" },
  responses: [
    { method: "POST", path: "/charges", status: 201, body: { id: "ch_1", ok: true } },
    { path: "/health", status: 200, body: "fine" },
  ],
};

describe("matching", () => {
  test("hosts match exactly or by suffix pattern", () => {
    expect(hostMatches("api.example.com", "api.example.com")).toBe(true);
    expect(hostMatches("api.example.com", "www.example.com")).toBe(false);
    expect(hostMatches("*.example.com", "api.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
  });

  test("the first matching scripted response wins; no script means a default reply", () => {
    expect(findResponse(payments, "POST", "/charges")?.status).toBe(201);
    expect(findResponse(payments, "GET", "/charges")).toBeUndefined(); // method mismatch, and /health differs
    expect(findResponse(payments, "GET", "/health")?.status).toBe(200);
    expect(findResponse(payments, "GET", "/nope")).toBeUndefined();
    const { responses: _unused, ...unscripted } = payments;
    expect(findResponse(unscripted, "GET", "/anything")).toBeNull();
    expect(
      findResponse({ ...payments, responses: [{ path: "/v1/*", status: 204 }] }, "GET", "/v1/x")
        ?.status,
    ).toBe(204);
  });
});

describe("scripted fetch without hooks (raw side)", () => {
  test("answers from the script, parses JSON bodies, and dedupes by the declared header", async () => {
    const reasons: string[] = [];
    const { fetch: f } = createScriptedFetch([payments], null, (r) => reasons.push(r));
    const first = await f("https://api.payments.example/charges", {
      method: "POST",
      headers: { "Idempotency-Key": "o-1" },
      body: JSON.stringify({ orderId: "o-1" }),
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ id: "ch_1", ok: true });
    const again = await f("https://api.payments.example/charges", {
      method: "POST",
      headers: { "idempotency-key": "o-1" },
    });
    expect(again.status).toBe(201);
    expect(await again.text()).toBe('{"id":"ch_1","ok":true}');
    expect(reasons).toEqual([]);
  });

  test("declared headers keep their case-insensitive name; JSON gets a content type only when none is declared", async () => {
    const { fetch: f } = createScriptedFetch(
      [
        {
          name: "p",
          host: "p.example",
          guarantees: {},
          responses: [
            {
              path: "/problem",
              status: 400,
              headers: { "Content-Type": "application/problem+json" },
              body: { title: "x" },
            },
            { path: "/plain", status: 200, body: { ok: 1 } },
          ],
        },
      ],
      null,
      () => {},
    );
    expect((await f("https://p.example/problem")).headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect((await f("https://p.example/plain")).headers.get("content-type")).toBe(
      "application/json",
    );
  });

  test("a scripted redirect is unsupported unless the request opts out of following", async () => {
    const reasons: string[] = [];
    const { fetch: f } = createScriptedFetch(
      [
        {
          name: "r",
          host: "r.example",
          guarantees: {},
          responses: [{ status: 302, headers: { Location: "https://elsewhere.example/" } }],
        },
      ],
      null,
      (r) => reasons.push(r),
    );
    await expect(f("https://r.example/old")).rejects.toThrow(/redirects are not modelled/);
    expect(reasons[0]).toContain("302 redirect");
    expect((await f("https://r.example/old", { redirect: "manual" })).status).toBe(302);
  });

  test("the hook-free fetch calls afterRequest once per answered request", async () => {
    let n = 0;
    const { fetch: f } = createScriptedFetch(
      [payments],
      null,
      () => {},
      () => n++,
    );
    await f("https://api.payments.example/health");
    await f("https://api.payments.example/health");
    await f("https://other.example/").catch(() => undefined);
    expect(n).toBe(2);
  });

  test("an undeclared host or an unscripted route is unsupported and fails like a network error", async () => {
    const reasons: string[] = [];
    const { fetch: f } = createScriptedFetch([payments], null, (r) => reasons.push(r));
    await expect(f("https://other.example/x")).rejects.toThrow(/not a declared external/);
    await expect(f("https://api.payments.example/nope")).rejects.toThrow(/no scripted response/);
    expect(reasons).toHaveLength(2);
  });
});

describe("scripted fetch as effect points", () => {
  const spec: ScenarioSpec = {
    version: 1,
    name: "fetch",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
    setup: [],
    externals: [payments],
    invariants: [
      {
        kind: "atMostOncePerKey",
        name: "charged-once",
        effect: {
          target: "Fetch:payments",
          op: "POST",
          kind: "result",
          where: { "result.effective": true },
        },
        key: "args.body.orderId",
      },
    ],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 2,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };

  const charge = (idempotent: boolean) => async (message: { body: unknown; ack(): void }) => {
    const body = message.body as { orderId: string };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (idempotent) headers["Idempotency-Key"] = body.orderId;
    const res = await fetch("https://api.payments.example/charges", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`charge failed: ${res.status}`);
    message.ack();
  };

  test("records the request and the reply, attributed to the invocation", async () => {
    const log = await replay(spec, createFakePlatform(charge(true)), { seed: 1, faults: [] });
    const post = log.entries.filter((e) => e.target === "Fetch:payments");
    expect(post.map((e) => `${e.invocation} ${e.kind} ${e.op}`)).toEqual([
      "m1#1 call POST",
      "m1#1 result POST",
    ]);
    expect(post[0]?.payload).toEqual({
      args: {
        url: "https://api.payments.example/charges",
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "o-1" },
        body: { orderId: "o-1" },
        dedupeKey: "o-1",
      },
    });
    expect(post[1]?.payload).toMatchObject({
      result: { status: 201, effective: true, dedupeKey: "o-1" },
    });
  });

  test("a charge without an idempotency key is duplicated by redelivery; with one it is deduped", async () => {
    const bad = await explore(spec, createFakePlatform(charge(false)), {
      seed: "charge",
      now: () => 0,
    });
    expect(bad.kind).toBe("VIOLATED");
    if (bad.kind === "VIOLATED") expect(bad.violation.invariant).toBe("charged-once");
    const good = await explore(spec, createFakePlatform(charge(true)), {
      seed: "charge",
      maxRuns: 40,
      now: () => 0,
    });
    expect(good.kind).toBe("BOUNDED");
  });

  test("a fetch to an undeclared host makes the run UNSUPPORTED and restores fetch afterwards", async () => {
    const realFetch = fetch;
    const verdict = await explore(
      spec,
      createFakePlatform(async (message) => {
        await fetch("https://elsewhere.example/");
        message.ack();
      }),
      { seed: 1, maxRuns: 1, now: () => 0 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("undeclared host");
    expect(fetch).toBe(realFetch);
  });

  test("the buggy consumer still works with no externals declared", async () => {
    const verdict = await explore(
      { ...spec, externals: [], invariants: [] },
      createFakePlatform(buggyConsumer),
      { seed: 2, maxRuns: 2, now: () => 0 },
    );
    expect(verdict.kind).not.toBe("VIOLATED");
    const run = new Run({
      chooser: replayChooser({ seed: 1, faults: [] }),
      bounds: spec.bounds,
    });
    run.install();
    run.uninstall();
  });
});

describe("withoutNetwork", () => {
  test("fetch rejects while the work runs, the attempt is reported, and fetch is restored", async () => {
    const before = globalThis.fetch;
    const { value, requested } = await withoutNetwork(async () => {
      await expect(fetch("https://example.test/")).rejects.toThrow(/blocked/);
      return 7;
    });
    expect(value).toBe(7);
    expect(requested).toBe(true);
    expect(globalThis.fetch).toBe(before);
    expect((await withoutNetwork(async () => 1)).requested).toBe(false);
  });
});
