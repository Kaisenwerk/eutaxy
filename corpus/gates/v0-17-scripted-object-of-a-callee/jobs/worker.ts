/**
 * The jobs Worker: a pool object runs each job on a machine of its own, an
 * object of a second namespace backed by a container. The pool claims a
 * job before it boots the machine, so a boot whose answer was lost, or one
 * the pool did not live to record, is found `booting` and booted again
 * (booting a machine that runs is a no-op on the machine's side).
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly POOL: DurableObjectNamespace<Pool>;
  readonly MACHINE: DurableObjectNamespace<Machine>;
}

/** The container-backed class. It cannot come up in the test's isolate, and is never asked to. */
export class Machine extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    throw new Error("this isolate has no container");
  }

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

  async start(job: string): Promise<{ state: string }> {
    const sql = this.ctx.storage.sql;
    // The claim: durable before the boot leaves the object.
    sql.exec("INSERT OR IGNORE INTO jobs (id, state) VALUES (?, 'booting')", job);
    const { address } = await this.env.MACHINE.get(this.env.MACHINE.idFromName(job)).boot(job);
    sql.exec("UPDATE jobs SET state = 'running', address = ? WHERE id = ?", address, job);
    return { state: "running" };
  }
}

export default class Jobs extends WorkerEntrypoint<Env> {
  async start(job: string): Promise<{ state: string }> {
    return this.env.POOL.get(this.env.POOL.idFromName("pool")).start(job);
  }
}
