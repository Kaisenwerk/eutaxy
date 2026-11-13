/**
 * A pool object that runs each job on a machine of its own: an object of a
 * second namespace, backed by a container. The test's isolate has no
 * container, so the scenario scripts that namespace and no machine is ever
 * constructed; every call the pool (or the Worker) makes on a machine is
 * answered from the script.
 *
 * The pool claims a job before its machine is booted, so a boot whose
 * answer was lost, or one the pool did not live to record, is found
 * `booting` and booted again (booting a machine that runs is a no-op on
 * the machine's side). After its answer the pool warms the machine over
 * HTTP; a watchdog alarm warms whatever stayed cold. Stopping a job asks
 * for a snapshot first, which this deployment does not have, and halts the
 * machine either way.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly POOL: DurableObjectNamespace<Pool>;
  readonly MACHINE: DurableObjectNamespace<Machine>;
}

const watchdogMs = 30_000;

/** How many machines the runtime constructed: none, while the namespace is scripted. */
export const constructed = { machines: 0 };

/** The container-backed class. Nothing here can run in the test's isolate. */
export class Machine extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    constructed.machines++;
  }

  /** Start the container for a job; starting one that runs is a no-op. */
  async boot(_job: string): Promise<{ address: string }> {
    throw new Error("this isolate has no container");
  }

  async snapshot(): Promise<{ snapshot: string }> {
    throw new Error("this isolate has no container");
  }

  async halt(): Promise<{ halted: boolean }> {
    throw new Error("this isolate has no container");
  }

  async status(): Promise<{ up: boolean }> {
    throw new Error("this isolate has no container");
  }

  /** Requests go to the container's port. */
  override async fetch(_request: Request): Promise<Response> {
    throw new Error("this isolate has no container");
  }
}

export class Pool extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, address TEXT, warmed INTEGER NOT NULL DEFAULT 0)",
    );
  }

  private machine(job: string): DurableObjectStub<Machine> {
    return this.env.MACHINE.get(this.env.MACHINE.idFromName(job));
  }

  private stateOf(job: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ state: string }>("SELECT state FROM jobs WHERE id = ?", job)
      .toArray()[0]?.state;
  }

  /** Run a job on a machine of its own. */
  async start(job: string): Promise<{ state: string }> {
    const sql = this.ctx.storage.sql;
    // The claim: durable before the boot leaves the object, so a boot that was lost is found booting.
    sql.exec("INSERT OR IGNORE INTO jobs (id, state) VALUES (?, 'booting')", job);
    const state = this.stateOf(job);
    if (state !== "booting") return { state: state ?? "unknown" };
    const { address } = await this.machine(job).boot(job);
    sql.exec(
      "UPDATE jobs SET state = 'running', address = ? WHERE id = ? AND state = 'booting'",
      address,
      job,
    );
    await this.ctx.storage.setAlarm(Date.now() + watchdogMs);
    // The answer does not wait for the machine to warm up; what stays cold is the watchdog's.
    void this.warm(job).catch(() => {});
    return { state: this.stateOf(job) ?? "unknown" };
  }

  /** Stop a job: a snapshot if the machine can give one, then the halt. */
  async stop(job: string): Promise<{ state: string }> {
    const state = this.stateOf(job);
    if (state === undefined || state === "stopped") return { state: state ?? "unknown" };
    try {
      await this.machine(job).snapshot();
    } catch {
      // A job with no snapshot still stops.
    }
    await this.machine(job).halt();
    this.ctx.storage.sql.exec("UPDATE jobs SET state = 'stopped' WHERE id = ?", job);
    return { state: "stopped" };
  }

  /** The watchdog: whatever runs and stayed cold is warmed again. */
  override async alarm(): Promise<void> {
    const cold = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM jobs WHERE state = 'running' AND warmed = 0")
      .toArray();
    for (const { id } of cold) await this.warm(id);
  }

  private async warm(job: string): Promise<void> {
    // Queued behind the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.stateOf(job) !== "running") return;
    const response = await this.machine(job).fetch("http://machine/warm", { method: "POST" });
    if (!response.ok) throw new Error(`warm ${job}: ${response.status}`);
    this.ctx.storage.sql.exec("UPDATE jobs SET warmed = 1 WHERE id = ? AND state = 'running'", job);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, kind, job = ""] = new URL(request.url).pathname.split("/");
    // The Worker asking a machine itself, not through the pool.
    if (kind === "machines")
      return Response.json(await env.MACHINE.get(env.MACHINE.idFromName(job)).status());
    const pool = env.POOL.get(env.POOL.idFromName("pool"));
    if (request.method === "DELETE") return Response.json(await pool.stop(job));
    return Response.json(await pool.start(job));
  },
} satisfies ExportedHandler<Env>;
