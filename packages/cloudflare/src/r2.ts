/**
 * The R2 binding proxy. Every `put`, `delete`, `get`, `head` and `list` is
 * an effect point against the real Miniflare-backed bucket. A body is read
 * inside its `get`'s effect and handed back in an object with the same
 * fields and body methods: reading it later would be I/O the run cannot
 * see. An object's random `version` and wall-clock `uploaded` are replaced
 * by stand-ins (see `VersionBook`), so traces stay byte-identical.
 */

import {
  type EffectPoint,
  type FaultKind,
  type JsonValue,
  readFaults,
  toJson,
  writeFaults,
} from "@eutaxy/core";
import type { ProxyContext } from "./d1.ts";

/** Whether a binding is an R2 bucket (Miniflare's `R2Bucket`). */
export function isR2(value: unknown): value is R2Bucket {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["head", "get", "put", "delete", "list", "createMultipartUpload"].every(
    (m) => typeof v[m] === "function",
  );
}

/**
 * Stand-ins for the version and upload time of each object version the run
 * sees, in the order it first sees them: versions count up, and the time is
 * the virtual time it was first seen.
 */
export class VersionBook {
  private readonly seen = new Map<string, { version: string; uploaded: Date }>();

  clear(): void {
    this.seen.clear();
  }

  standIn(realVersion: string, at: number): { version: string; uploaded: Date } {
    let s = this.seen.get(realVersion);
    if (!s) {
      s = { version: (this.seen.size + 1).toString(16).padStart(32, "0"), uploaded: new Date(at) };
      this.seen.set(realVersion, s);
    }
    return { version: s.version, uploaded: new Date(s.uploaded.getTime()) };
  }
}

/** An object's metadata, with stand-ins for its version and upload time. */
function metadata(real: R2Object, book: VersionBook, at: number): R2Object {
  const { version, uploaded } = book.standIn(real.version, at);
  return {
    key: real.key,
    version,
    size: real.size,
    etag: real.etag,
    httpEtag: real.httpEtag,
    uploaded,
    httpMetadata: real.httpMetadata,
    customMetadata: real.customMetadata,
    range: real.range,
    checksums: real.checksums,
    storageClass: real.storageClass,
    ssecKeyMd5: real.ssecKeyMd5,
    writeHttpMetadata: (headers: Headers) => real.writeHttpMetadata(headers),
  } as R2Object;
}

/**
 * The bytes behind each body stream the proxy hands out. The stream itself
 * has no known length, which the runtime's put requires, so a put given one
 * (copying an object) is given its bytes instead.
 */
const buffered = new WeakMap<ReadableStream, () => Uint8Array>();

/**
 * An object with its body, already read: the stream and the body methods
 * share one consumption, as a real body's do. A method fails once the
 * stream is read, cancelled or locked by a reader; the stream ends empty
 * once a method has read the body.
 */
function withBody(meta: R2Object, bytes: Uint8Array): R2ObjectBody {
  let used = false;
  let stream: ReadableStream | undefined;
  const take = (): Uint8Array => {
    if (used || stream?.locked) throw new TypeError("Body has already been used");
    used = true;
    return bytes.slice();
  };
  // Defined, not assigned: Object.assign would call the getters and use the body up.
  return Object.defineProperties(meta, {
    body: {
      enumerable: true,
      get: () => {
        // Pulled only when read, so looking at the body does not use it.
        stream ??= new ReadableStream(
          {
            pull(controller) {
              if (!used) controller.enqueue(bytes.slice());
              used = true;
              controller.close();
            },
            cancel() {
              used = true;
            },
          },
          { highWaterMark: 0 },
        );
        buffered.set(stream, take);
        return stream;
      },
    },
    bodyUsed: { enumerable: true, get: () => used },
    arrayBuffer: { value: async () => take().buffer as ArrayBuffer },
    bytes: { value: async () => take() },
    text: { value: async () => new TextDecoder().decode(take()) },
    json: { value: async () => JSON.parse(new TextDecoder().decode(take())) as unknown },
    blob: { value: async () => new Blob([take()]) },
  }) as unknown as R2ObjectBody;
}

/** Conditions as the trace keeps them: a `Headers` object by its entries. */
function conditions(onlyIf: unknown): { onlyIf?: unknown } {
  if (onlyIf === undefined) return {};
  return { onlyIf: onlyIf instanceof Headers ? Object.fromEntries(onlyIf.entries()) : onlyIf };
}

/** What the trace keeps of a get's options: the conditions and range, never an encryption key. */
function getArgs(key: string, options: R2GetOptions | undefined): JsonValue {
  return toJson({
    key,
    ...conditions(options?.onlyIf),
    ...(options?.range === undefined ? {} : { range: options.range }),
  });
}

/** What the trace keeps of a put's options: the conditions and metadata, not checksums or keys. */
function putArgs(options: R2PutOptions | undefined): JsonValue {
  if (!options) return {};
  return toJson({
    ...conditions(options.onlyIf),
    ...(options.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
    ...(options.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
  });
}

export function proxyR2(
  real: R2Bucket,
  binding: string,
  ctx: ProxyContext,
  book: VersionBook,
): R2Bucket {
  const target = `R2:${binding}`;
  const point = (op: string, args: JsonValue, allowed: readonly FaultKind[]): EffectPoint => ({
    invocation: ctx.currentInvocation(),
    target,
    op,
    args,
    allowed,
  });
  const notModelled = (what: string): never => {
    const reason = `R2 ${binding}: ${what} is not modelled`;
    ctx.hooks.unsupported(reason);
    throw new Error(`eutaxy: ${reason}`);
  };
  /** Date conditions compare the store's real upload time, not the stand-in the Worker saw. */
  const checkConditions = (onlyIf: unknown): void => {
    const datedHeaders = ["if-modified-since", "if-unmodified-since"];
    const dated =
      onlyIf instanceof Headers
        ? datedHeaders.some((h) => onlyIf.has(h))
        : typeof onlyIf === "object" &&
          onlyIf !== null &&
          ("uploadedBefore" in onlyIf || "uploadedAfter" in onlyIf);
    if (dated)
      ctx.hooks.unsupported(`R2 ${binding}: conditions on the upload time are not modelled`);
  };
  const described = (o: R2Object | null) =>
    o === null ? { found: false } : { found: true, key: o.key, size: o.size, etag: o.etag };
  return {
    put: (key: string, value: unknown, options?: R2PutOptions) =>
      ctx.hooks.effect(
        point("put", { key, ...(putArgs(options) as object) }, writeFaults),
        async () => {
          checkConditions(options?.onlyIf);
          const read = value instanceof ReadableStream ? buffered.get(value) : undefined;
          const stored = await real.put(key, (read ? read() : value) as never, options);
          return stored === null ? null : metadata(stored, book, Date.now());
        },
        (o) => (o === null ? { stored: false } : { stored: true, size: o.size, etag: o.etag }),
      ),
    delete: (keys: string | string[]) =>
      ctx.hooks.effect(
        point("delete", { keys: typeof keys === "string" ? [keys] : [...keys] }, writeFaults),
        () => real.delete(keys),
        () => null,
      ),
    get: (key: string, options?: R2GetOptions) =>
      ctx.hooks.effect(
        point("get", getArgs(key, options), readFaults),
        async () => {
          checkConditions(options?.onlyIf);
          const o = await real.get(key, options);
          if (o === null) return null;
          const meta = metadata(o, book, Date.now());
          // A failed precondition answers the metadata without a body.
          if (!("body" in o)) return meta;
          return withBody(meta, new Uint8Array(await (o as R2ObjectBody).arrayBuffer()));
        },
        (o) => ({ ...described(o), ...(o !== null ? { body: "body" in o } : {}) }),
      ),
    head: (key: string) =>
      ctx.hooks.effect(
        point("head", { key }, readFaults),
        async () => {
          const o = await real.head(key);
          return o === null ? null : metadata(o, book, Date.now());
        },
        described,
      ),
    list: (options?: R2ListOptions) =>
      ctx.hooks.effect(
        point("list", toJson(options ?? {}), readFaults),
        async () => {
          const listed = await real.list(options);
          const at = Date.now();
          return { ...listed, objects: listed.objects.map((o) => metadata(o, book, at)) };
        },
        (l) => ({
          keys: l.objects.map((o) => o.key),
          truncated: l.truncated,
          delimitedPrefixes: l.delimitedPrefixes,
        }),
      ),
    createMultipartUpload: () => notModelled("createMultipartUpload()"),
    resumeMultipartUpload: () => notModelled("resumeMultipartUpload()"),
  } as unknown as R2Bucket;
}

/** An object a setup seeds: its text, or its text with metadata. */
export type R2Seed =
  | string
  | {
      readonly value: string;
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly httpMetadata?: Readonly<Record<string, string>>;
    };

/** Every object of the bucket, through all pages of a listing. */
async function allObjects(real: R2Bucket): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page: R2Objects = await real.list({
      include: ["customMetadata", "httpMetadata"],
      ...(cursor === undefined ? {} : { cursor }),
    });
    out.push(...page.objects);
    if (!page.truncated) return out;
    cursor = page.cursor;
  }
}

/** Empty the bucket and put its seeds, before a run. */
export async function resetR2(
  real: R2Bucket,
  seeds: Readonly<Record<string, R2Seed>>,
): Promise<void> {
  const keys = (await allObjects(real)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) await real.delete(keys.slice(i, i + 1000));
  for (const [key, seed] of Object.entries(seeds)) {
    if (typeof seed === "string") await real.put(key, seed);
    else
      await real.put(key, seed.value, {
        ...(seed.customMetadata ? { customMetadata: { ...seed.customMetadata } } : {}),
        ...(seed.httpMetadata ? { httpMetadata: { ...seed.httpMetadata } } : {}),
      });
  }
}

/** Largest object whose text the snapshot keeps. */
const snapshotTextLimit = 4096;

/**
 * The bucket's objects as rows `{ key, size, etag, customMetadata,
 * httpMetadata, text? }` by key, `text` for an object of up to 4 KiB that is
 * valid UTF-8. Versions and upload times are left out: they are the store's,
 * not the Worker's.
 */
export async function snapshotR2(real: R2Bucket): Promise<JsonValue[]> {
  const rows: JsonValue[] = [];
  const objects = (await allObjects(real)).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const o of objects) {
    let text: string | undefined;
    if (o.size <= snapshotTextLimit) {
      const body = await real.get(o.key);
      if (body && "body" in body) {
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            await body.arrayBuffer(),
          );
        } catch {
          // not text: the size and etag stand for it
        }
      }
    }
    rows.push(
      toJson({
        key: o.key,
        size: o.size,
        etag: o.etag,
        customMetadata: o.customMetadata ?? {},
        httpMetadata: o.httpMetadata ?? {},
        ...(text === undefined ? {} : { text }),
      }),
    );
  }
  return rows;
}
