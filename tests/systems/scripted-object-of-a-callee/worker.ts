/**
 * The front Worker: a request starts a job on the jobs Worker, reached
 * through a service binding by RPC.
 */

export interface Env {
  readonly JOBS: Fetcher & { start(job: string): Promise<{ state: string }> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const job = new URL(request.url).pathname.split("/").at(-1) ?? "";
    return Response.json(await env.JOBS.start(job), { status: 201 });
  },
} satisfies ExportedHandler<Env>;
