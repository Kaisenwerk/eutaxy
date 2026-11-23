/**
 * An object whose alarm does what it was told when it was armed: `arm`
 * stores whether each delivery of the alarm in turn is handled and sets the
 * alarm for now; `alarm` returns when this delivery is handled and throws
 * when it is not, so the runtime retries it. Each run of `alarm` is noted
 * in `ran`, outside the object, where a failed run leaves its note.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly REMINDER: DurableObjectNamespace<Reminder>;
}

/** The retries each run of `alarm` was told of, in order, by the object's id. */
export const ran = new Map<string, number[]>();

export class Reminder extends DurableObject<Env> {
  async arm(handled: readonly boolean[]): Promise<void> {
    await this.ctx.storage.put("handled", handled);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const id = this.ctx.id.toString();
    ran.set(id, [...(ran.get(id) ?? []), info?.retryCount ?? 0]);
    const handled = (await this.ctx.storage.get<boolean[]>("handled")) ?? [];
    // Past the list's end the model says no delivery is made: one made anyway is not handled either.
    if (!(handled[info?.retryCount ?? 0] ?? false)) throw new Error("not handled");
  }
}

export default {
  /** Arms the reminder the request's path names with the outcomes in its body. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    await env.REMINDER.getByName(name).arm(await request.json());
    return new Response("armed");
  },
} satisfies ExportedHandler<Env>;
