/**
 * The payments Worker: other Workers charge through its `Payments`
 * entrypoint over a service binding. A charge is idempotent per key, as
 * payment APIs promise: a second call with the same key gets the first
 * charge back and charges nothing more.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
}

export interface Charge {
  readonly chargeId: number;
}

export class Payments extends WorkerEntrypoint<Env> {
  async charge(idempotencyKey: string, orderId: string, amountCents: number): Promise<Charge> {
    await this.env.DB.prepare(
      "INSERT INTO charges (idempotency_key, order_id, amount_cents) VALUES (?1, ?2, ?3) ON CONFLICT (idempotency_key) DO NOTHING",
    )
      .bind(idempotencyKey, orderId, amountCents)
      .run();
    const row = await this.env.DB.prepare(
      "SELECT charge_id FROM charges WHERE idempotency_key = ?1",
    )
      .bind(idempotencyKey)
      .first<{ charge_id: number }>();
    if (!row) throw new Error(`no charge for ${idempotencyKey}`);
    return { chargeId: row.charge_id };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("payments is reached through its entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
