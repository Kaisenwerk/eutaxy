/**
 * A pool object that runs each job on a machine of its own: an object of a
 * second namespace, backed by a container, which the scenario scripts. The
 * pool's table of jobs is all that knows which machines run: whoever stops
 * a job, or sweeps what was left running, reads it.
 *
 * Planted bug: the pool boots the machine first and records the job after.
 * When the machine booted and the pool did not get to record it (the pool
 * was reset right after the call, or the call's answer was lost), a
 * machine runs that no record names, and nothing will ever halt it.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly POOL: DurableObjectNamespace<Pool>;
  readonly SAFE_POOL: DurableObjectNamespace<FixedPool>;
  readonly MACHINE: DurableObjectNamespace<Machine>;
}

/** The container-backed class. Nothing here can run in the test's isolate. */
export class Machine extends DurableObject<Env> {
  /** Start the container for a job; starting one that runs is a no-op. */
  async boot(_job: string): Promise<{ address: string }> {
    throw new Error("this isolate has no container");
  }
}

export class Pool extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, address TEXT)",
    );
  }

  protected machine(job: string): DurableObjectStub<Machine> {
    return this.env.MACHINE.get(this.env.MACHINE.idFromName(job));
  }

  protected running(job: string, address: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (id, state, address) VALUES (?1, 'running', ?2) ON CONFLICT (id) DO UPDATE SET state = 'running', address = ?2",
      job,
      address,
    );
  }

  /** Run a job on a machine of its own. */
  async start(job: string): Promise<{ state: string }> {
    // The planted bug: the boot leaves before anything records that the job has a machine.
    const { address } = await this.machine(job).boot(job);
    this.running(job, address);
    return { state: "running" };
  }
}

/**
 * The fix: the job is claimed, recorded as `booting`, before the boot
 * leaves. The claim is durable before the call leaves the object, as the
 * output gate guarantees, so a pool reset after the boot finds it; a job
 * left `booting` is one whose machine may run, for a sweep to halt or a
 * resend to adopt.
 */
export class FixedPool extends Pool {
  override async start(job: string): Promise<{ state: string }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO jobs (id, state) VALUES (?, 'booting')", job);
    const { address } = await this.machine(job).boot(job);
    this.running(job, address);
    return { state: "running" };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const job = url.pathname.split("/").at(-1) ?? "";
    const namespace = url.searchParams.has("fixed") ? env.SAFE_POOL : env.POOL;
    const pool = namespace.get(namespace.idFromName("pool"));
    return Response.json(await pool.start(job), { status: 201 });
  },
} satisfies ExportedHandler<Env>;
