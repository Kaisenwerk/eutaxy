/**
 * A document store that exercises every modelled R2 operation on each
 * request: put with metadata, get and its body, head, list, a conditional
 * put on the etag it just read, a paged list, a copy that hands one
 * object's body to another put, and delete. Correct by construction, so the
 * differential check is about the proxies, not the Worker.
 */

export interface Env {
  readonly FILES: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { id, text } = (await request.json()) as { id: string; text: string };
    const key = `docs/${id}`;
    await env.FILES.put(`tmp/${id}`, text);
    await env.FILES.put(key, text, {
      customMetadata: { id },
      httpMetadata: { contentType: "text/plain" },
    });
    const stored = await env.FILES.get(key);
    if (stored === null) return new Response("lost", { status: 500 });
    const body = await stored.text();
    const head = await env.FILES.head(key);
    // The seeded document, read through its stream rather than a body method.
    const readme = await env.FILES.get("docs/readme");
    const streamed = readme === null ? "" : await new Response(readme.body).text();
    // Only if nobody changed it since the get: appends a line, keeping the metadata.
    const updated = await env.FILES.put(key, `${body}\nreviewed`, {
      onlyIf: { etagMatches: stored.etag },
      customMetadata: { ...head?.customMetadata, reviewed: "yes" },
    });
    // A stale etag: this put must not happen.
    const stale = await env.FILES.put(key, "overwritten", { onlyIf: { etagMatches: stored.etag } });
    // Two at a time, so the cursor goes back into the next call.
    const docs: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({
        prefix: "docs/",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      docs.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // Copy the temporary object by handing its body straight to put.
    const temp = await env.FILES.get(`tmp/${id}`);
    if (temp !== null) await env.FILES.put(`tmp/${id}.copy`, temp.body);
    await env.FILES.delete([`tmp/${id}`, `tmp/${id}.copy`]);
    return Response.json({ updated: updated !== null, stale: stale !== null, docs, streamed });
  },
};
