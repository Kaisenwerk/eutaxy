/**
 * The front Worker with a planted bug in what it does with a notice: it
 * records every notice it is sent. The turns Worker sends a notice again
 * when it got no answer for the first, which it must, since it cannot know
 * whether the first arrived; a notice whose answer was lost is then
 * recorded twice.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { type Env, wake } from "./worker.ts";

export { default, RequestFlow } from "./worker.ts";

export class Notices extends WorkerEntrypoint<Env> {
  async turnEnded(id: string, reply: string): Promise<void> {
    // The planted bug: no check that this request's notice is there already.
    await this.env.DB.prepare("INSERT INTO notices (request_id, reply) VALUES (?1, ?2)")
      .bind(id, reply)
      .run();
    await wake(this.env, id, reply);
  }
}
