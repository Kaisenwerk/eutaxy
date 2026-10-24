/**
 * Reminders kept in a Durable Object and sent from its alarm through an
 * external mail API.
 *
 * Planted bug: the alarm sends the reminder, then marks it sent. Alarms run
 * at least once: when the handler dies, or its call to the mail API fails
 * after the mail went out, the alarm is retried and the reminder is sent a
 * second time. The fix sends with an idempotency key the mail API
 * deduplicates by, so the retry is harmless.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly REMINDERS: DurableObjectNamespace<Reminders>;
}

interface Reminder {
  readonly id: string;
  readonly due: number;
  sent: boolean;
}

export class Reminders extends DurableObject<Env> {
  /** Whether sends carry an idempotency key; the planted bug sends without one. */
  protected readonly idempotent: boolean = false;

  async add(id: string, inMs: number): Promise<void> {
    const reminder: Reminder = { id, due: Date.now() + inMs, sent: false };
    await this.ctx.storage.put(`reminder:${id}`, reminder);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || reminder.due < alarm) await this.ctx.storage.setAlarm(reminder.due);
  }

  override async alarm(): Promise<void> {
    const reminders = [
      ...(await this.ctx.storage.list<Reminder>({ prefix: "reminder:" })).values(),
    ];
    for (const r of reminders) {
      if (r.sent || r.due > Date.now()) continue;
      const res = await fetch("https://mail.example/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.idempotent ? { "Idempotency-Key": r.id } : {}),
        },
        body: JSON.stringify({ reminderId: r.id }),
      });
      if (!res.ok) throw new Error(`send failed with ${res.status}`);
      r.sent = true;
      await this.ctx.storage.put(`reminder:${r.id}`, r);
    }
    const next = reminders.filter((r) => !r.sent && r.due > Date.now()).map((r) => r.due);
    if (next.length > 0) await this.ctx.storage.setAlarm(Math.min(...next));
  }
}

/** The fix: every send carries the reminder's id as its idempotency key. */
export class FixedReminders extends Reminders {
  protected override readonly idempotent: boolean = true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/reminders") {
      return new Response("not found", { status: 404 });
    }
    const { id, inMs } = (await request.json()) as { id: string; inMs: number };
    await env.REMINDERS.getByName("reminders").add(id, inMs);
    return new Response("scheduled", { status: 202 });
  },
} satisfies ExportedHandler<Env>;
