/**
 * A book of jobs kept by one object, which starts a Workflow instance for
 * each job through its own env; the instance does the work in a step and
 * tells the book when it is done. The instance's id is made from the
 * job's, so a job submitted twice (the caller's resend, after the first
 * answer was lost or the object was reset) starts one run: the engine
 * refuses the second create, and the book takes that as started.
 */

import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface Env {
  readonly JOBS: DurableObjectNamespace<Jobs>;
  readonly RUNS: Workflow;
  readonly CACHE: KVNamespace;
}

export type RunParams = { readonly id: string };

const runOf = (id: string): string => `run-${id}`;

export class Jobs extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, run_id TEXT)",
    );
  }

  /** Take the job and start its run. */
  async submit(id: string): Promise<{ run: string }> {
    const run = runOf(id);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO jobs (id, status) VALUES (?, 'accepted')", id);
    try {
      await this.env.RUNS.create({ id: run, params: { id } });
    } catch (err) {
      // The run is there already: an earlier submit created it and did not live to record it.
      if (!(err as Error).message.includes("instance.already_exists")) throw err;
    }
    // The run may have finished the job while the create's answer came back.
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'started', run_id = ? WHERE id = ? AND status = 'accepted'",
      run,
      id,
    );
    return { run };
  }

  /** The run's step, telling the book its work is done. */
  async finish(id: string): Promise<{ done: true }> {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'done', run_id = ? WHERE id = ?",
      runOf(id),
      id,
    );
    return { done: true };
  }

  /** How the job's run stands, asked of the engine through the instance the binding gives. */
  async progress(id: string): Promise<string> {
    try {
      const instance = await this.env.RUNS.get(runOf(id));
      return (await instance.status()).status;
    } catch {
      return "unknown";
    }
  }

  /** A read through a binding of a kind the simulation does not model. */
  async cached(id: string): Promise<string | null> {
    return this.env.CACHE.get(id);
  }
}

export class RunJob extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { id } = event.payload;
    const book = this.env.JOBS.get(this.env.JOBS.idFromName("book"));
    await step.do("work", async () => {
      await book.finish(id);
      return { done: true };
    });
    return { finished: id };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, kind, id = ""] = new URL(request.url).pathname.split("/");
    const book = env.JOBS.get(env.JOBS.idFromName("book"));
    if (kind === "jobs" && request.method === "POST")
      return Response.json(await book.submit(id), { status: 202 });
    if (kind === "jobs") return Response.json({ status: await book.progress(id) });
    if (kind === "cached") return Response.json({ value: await book.cached(id) });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
