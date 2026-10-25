/**
 * A test double for an R2 bucket, for the platform's Node tests: objects in
 * memory, a version and upload time on every put that differ from run to
 * run as the real store's do, and `onlyIf` on etags. The real bucket's behaviour
 * is checked in the corpus against Miniflare.
 */

interface Stored {
  readonly bytes: Uint8Array;
  readonly version: string;
  readonly uploaded: Date;
  readonly customMetadata: Record<string, string>;
  readonly httpMetadata: R2HTTPMetadata;
}

/** FNV-1a over the bytes, in hex: stands for the MD5 etag the real store gives. */
function etagOf(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new TypeError("the fake bucket takes strings, bytes and blobs");
}

/**
 * Counts every put across buckets and runs, so versions and upload times
 * differ from run to run as the real store's do, whatever globals a run patches.
 */
let serial = 0;

export class FakeR2 {
  readonly objects = new Map<string, Stored>();
  /** Bodies handed out, and how many of them were read. */
  bodiesGiven = 0;
  bodiesRead = 0;

  private meta(key: string, s: Stored): R2Object {
    const etag = etagOf(s.bytes);
    return {
      key,
      version: s.version,
      size: s.bytes.length,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: s.uploaded,
      httpMetadata: { ...s.httpMetadata },
      customMetadata: { ...s.customMetadata },
      checksums: { toJSON: () => ({}) },
      storageClass: "Standard",
      writeHttpMetadata: (headers: Headers) => {
        if (s.httpMetadata.contentType) headers.set("content-type", s.httpMetadata.contentType);
      },
    } as unknown as R2Object;
  }

  private passes(s: Stored | undefined, onlyIf: unknown): boolean {
    if (!onlyIf || typeof onlyIf !== "object") return true;
    const c = onlyIf as R2Conditional;
    const etag = s === undefined ? undefined : etagOf(s.bytes);
    if (c.etagMatches !== undefined && etag !== c.etagMatches) return false;
    if (c.etagDoesNotMatch !== undefined && etag === c.etagDoesNotMatch) return false;
    return true;
  }

  async head(key: string): Promise<R2Object | null> {
    const s = this.objects.get(key);
    return s === undefined ? null : this.meta(key, s);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null> {
    const s = this.objects.get(key);
    if (s === undefined) return null;
    const meta = this.meta(key, s);
    if (!this.passes(s, options?.onlyIf)) return meta;
    this.bodiesGiven++;
    const bytes = s.bytes.slice();
    return Object.assign(meta, {
      body: new ReadableStream(),
      bodyUsed: false,
      arrayBuffer: async () => {
        this.bodiesRead++;
        return bytes.buffer;
      },
    }) as unknown as R2ObjectBody;
  }

  async put(key: string, value: unknown, options?: R2PutOptions): Promise<R2Object | null> {
    if (!this.passes(this.objects.get(key), options?.onlyIf)) return null;
    const s: Stored = {
      bytes: await bytesOf(value),
      version: `v${++serial}`,
      uploaded: new Date(1_700_000_000_000 + serial * 7919),
      customMetadata: { ...(options?.customMetadata ?? {}) },
      httpMetadata: { ...((options?.httpMetadata as R2HTTPMetadata | undefined) ?? {}) },
    };
    this.objects.set(key, s);
    return this.meta(key, s);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const k of typeof keys === "string" ? [keys] : keys) this.objects.delete(k);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = options?.cursor === undefined ? 0 : Number(options.cursor);
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => this.meta(k, this.objects.get(k) as Stored)),
      delimitedPrefixes: [],
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    } as R2Objects;
  }

  async createMultipartUpload(): Promise<never> {
    throw new Error("the fake bucket has no multipart uploads");
  }

  resumeMultipartUpload(): never {
    throw new Error("the fake bucket has no multipart uploads");
  }
}
