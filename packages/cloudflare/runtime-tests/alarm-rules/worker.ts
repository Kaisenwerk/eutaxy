/**
 * An object that changes its alarm as it was told and whose handler fails
 * when it was told to: `arm` sets the alarm, then makes each change in
 * turn, setting it again or deleting it; `alarm` notes its run in `ran`,
 * outside the object, where a failed run leaves its note, and throws when
 * the object was armed to fail, so the runtime retries it.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly REMINDER: DurableObjectNamespace<Reminder>;
}

/** What the request arming an object carries. */
export interface Armed {
  /** The changes made after the alarm is first set, in order: true sets it again, false deletes it. */
  readonly changes: readonly boolean[];
  /** Whether every run of the handler fails. */
  readonly fails: boolean;
}

/** The time and the retries so far of each run of `alarm`, in order, by the object's id. */
export const ran = new Map<string, { at: number; retryCount: number }[]>();

export class Reminder extends DurableObject<Env> {
  async arm({ changes, fails }: Armed): Promise<void> {
    await this.ctx.storage.put("fails", fails);
    // Each alarm is due a second before the one set before it, so one that was replaced is still
    // pending when its replacement fires and comes due after it.
    let due = Date.now() + 5_000;
    await this.ctx.storage.setAlarm(due);
    for (const set of changes) {
      due -= 1_000;
      if (set) await this.ctx.storage.setAlarm(due);
      else await this.ctx.storage.deleteAlarm();
    }
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const id = this.ctx.id.toString();
    ran.set(id, [...(ran.get(id) ?? []), { at: Date.now(), retryCount: info?.retryCount ?? 0 }]);
    if (await this.ctx.storage.get<boolean>("fails")) throw new Error("the alarm failed");
  }
}

export default {
  /** Arms the reminder the request's path names as its body says. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    await env.REMINDER.getByName(name).arm(await request.json());
    return new Response("armed");
  },
} satisfies ExportedHandler<Env>;
