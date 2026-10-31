/**
 * Scripted outbound fetch. During a run, `fetch` is replaced by a function
 * that answers from the scenario's declared externals instead of the
 * network. Each request is an effect point (with every fault available) when
 * run hooks are given; without hooks it is the same scripted behaviour with
 * no recording, which the differential's raw side uses.
 *
 * An external that declares `dedupeBy` remembers the first response per key
 * for the run: a repeated key gets that response back and is recorded as
 * not effective. A request to an undeclared host, or one no scripted
 * response answers, makes the run unsupported.
 */

import {
  type ExternalDecl,
  type JsonValue,
  type RunHooks,
  type ScriptedResponse,
  writeFaults,
} from "@eutaxy/core";
import { patchProperty } from "./patch.ts";

export interface FetchHooks {
  readonly hooks: RunHooks;
  readonly invocation: () => string;
}

/** Match a host against an exact host or a "*.suffix" pattern. */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

export function findExternal(
  externals: readonly ExternalDecl[],
  host: string,
): ExternalDecl | undefined {
  return externals.find((e) => hostMatches(e.host, host));
}

export function findResponse(
  external: ExternalDecl,
  method: string,
  path: string,
): ScriptedResponse | undefined | null {
  if (!external.responses) return null; // null: no script at all, default reply
  return external.responses.find((r) => {
    if (r.method && r.method.toUpperCase() !== method) return false;
    if (r.path === undefined) return true;
    return r.path.endsWith("*") ? path.startsWith(r.path.slice(0, -1)) : r.path === path;
  });
}

interface Reply {
  readonly status: number;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function replyOf(r: ScriptedResponse | null): Reply {
  if (r === null) return { status: 200, headers: {}, body: "" };
  const json = r.body !== undefined && typeof r.body !== "string";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(r.headers ?? {})) headers[name.toLowerCase()] = value;
  if (json && !("content-type" in headers)) headers["content-type"] = "application/json";
  const body = r.body === undefined ? "" : json ? JSON.stringify(r.body) : (r.body as string);
  return { status: r.status, headers, body };
}

function toResponse(reply: Reply): Response {
  return new Response(reply.body === "" ? null : reply.body, {
    status: reply.status,
    headers: reply.headers,
  });
}

function parseBody(text: string): JsonValue {
  if (text === "") return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export interface ScriptedFetch {
  readonly fetch: typeof fetch;
  /** Replies already given per external and dedupe key, for the run. */
  readonly dedupe: Map<string, Reply>;
}

/**
 * Build the replacement `fetch`. With `hooks`, every request is an effect
 * point recorded as `Fetch:<external>` with the method as op; the result
 * summary carries `status`, `effective` and the dedupe key.
 */
export function createScriptedFetch(
  externals: readonly ExternalDecl[],
  hooks: FetchHooks | null,
  unsupported: (reason: string) => void,
  /** Called after each answered request without hooks, e.g. to advance a clock the way an effect would. */
  afterRequest: () => void = () => {},
): ScriptedFetch {
  const dedupe = new Map<string, Reply>();

  const scripted = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const external = findExternal(externals, url.host);
    if (!external) {
      unsupported(
        `fetch to undeclared host ${url.host}; declare it as an external in the scenario`,
      );
      throw new TypeError(`fetch failed: ${url.host} is not a declared external`);
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const dedupeHeader = external.guarantees.dedupeBy?.toLowerCase();
    const dedupeKey = dedupeHeader ? (headers[dedupeHeader] ?? null) : null;
    const body = parseBody(await request.text());
    const args: JsonValue = { url: request.url, method, headers, body, dedupeKey };

    const perform = async (): Promise<{ reply: Reply; effective: boolean }> => {
      const memo = dedupeKey === null ? null : `${external.name}\u0000${dedupeKey}`;
      if (memo !== null) {
        const earlier = dedupe.get(memo);
        if (earlier) return { reply: earlier, effective: false };
      }
      const script = findResponse(external, method, url.pathname);
      if (script === undefined) {
        unsupported(
          `no scripted response in external ${external.name} for ${method} ${url.pathname}`,
        );
        throw new TypeError(`fetch failed: no scripted response for ${method} ${url.pathname}`);
      }
      const reply = replyOf(script);
      if (REDIRECTS.has(reply.status) && request.redirect !== "manual") {
        unsupported(
          `external ${external.name} answers ${method} ${url.pathname} with a ${reply.status} redirect; script the final reply or fetch with redirect: "manual"`,
        );
        throw new TypeError(
          `fetch failed: redirects are not modelled (${reply.status} from ${url.host})`,
        );
      }
      if (memo !== null) dedupe.set(memo, reply);
      return { reply, effective: true };
    };

    if (!hooks) {
      const { reply } = await perform();
      afterRequest();
      return toResponse(reply);
    }
    const { reply } = await hooks.hooks.effect(
      {
        invocation: hooks.invocation(),
        target: `Fetch:${external.name}`,
        op: method,
        args,
        allowed: writeFaults,
      },
      perform,
      (r) => ({ status: r.reply.status, effective: r.effective, dedupeKey }),
    );
    return toResponse(reply);
  }) as typeof fetch;

  return { fetch: scripted, dedupe };
}

/** Replace the global `fetch` for a run; returns the function that restores it. */
export function installScriptedFetch(
  externals: readonly ExternalDecl[],
  hooks: FetchHooks | null,
  unsupported: (reason: string) => void,
  afterRequest?: () => void,
): () => void {
  const { fetch: scripted } = createScriptedFetch(externals, hooks, unsupported, afterRequest);
  return patchProperty(globalThis, "fetch", { value: scripted });
}

/**
 * Run platform work (a reset, a snapshot) with no network: `fetch` rejects
 * while it runs. Reports whether anything tried, so code that runs outside
 * the simulation (an object's constructor during a reset) cannot reach the
 * network unseen.
 */
export async function withoutNetwork<T>(
  work: () => Promise<T>,
): Promise<{ readonly value: T; readonly requested: boolean }> {
  let requested = false;
  const restore = patchProperty(globalThis, "fetch", {
    value: async () => {
      requested = true;
      throw new TypeError("network access is blocked while Eutaxy resets or snapshots state");
    },
  });
  try {
    return { value: await work(), requested };
  } finally {
    restore();
  }
}
