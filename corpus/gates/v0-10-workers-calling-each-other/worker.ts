/**
 * An orders Worker in a system of Workers: it is called over RPC by the
 * storefront, asks the logistics partner (another Worker, over a service
 * binding) for prices and shipments, keeps orders in D1, and hands each
 * order's fulfilment to a Workflow that waits for the shipment event. A Cron
 * Trigger reconciles orders whose shipment confirmation never arrived.
 *
 * Everything here is idempotent on the order id, so a lost answer and the
 * resend that follows change nothing: the v0.10 gate Worker.
 */
import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export interface Env {
  readonly DB: D1Database;
  /** The logistics partner's Worker, over a service binding. */
  readonly PARTNER: Fetcher & Partner;
  readonly FULFILMENT: Workflow;
}

/** The partner's entrypoint, as this Worker calls it. */
export interface Partner {
  quote(sku: string): Promise<{ priceCents: number }>;
  shipment(orderId: string): Promise<{ trackingId: string } | null>;
}

type Shipped = { readonly trackingId: string };

/** One order's fulfilment: waits for the shipment, then marks the order shipped. */
export class Fulfilment extends WorkflowEntrypoint<Env, { orderId: string }> {
  override async run(event: WorkflowEvent<{ orderId: string }>, step: WorkflowStep) {
    const shipped = await step.waitForEvent<Shipped>("shipped", {
      type: "shipped",
      timeout: "7 days",
    });
    await step.do("mark shipped", async () => {
      await this.env.DB.prepare(
        "UPDATE orders SET status = 'shipped', tracking_id = ?2 WHERE order_id = ?1 AND status = 'placed'",
      )
        .bind(event.payload.orderId, shipped.payload.trackingId)
        .run();
      return null;
    });
    return { orderId: event.payload.orderId, trackingId: shipped.payload.trackingId };
  }
}

/** Start an order's fulfilment if it is not running yet; a second create is refused, and that is fine. */
async function ensureFulfilment(env: Env, orderId: string): Promise<void> {
  try {
    await env.FULFILMENT.create({ id: orderId, params: { orderId } });
  } catch (err) {
    if (!String(err).includes("instance.already_exists")) throw err;
  }
}

/** The storefront calls these over a service binding. */
export class Orders extends WorkerEntrypoint<Env> {
  /** Quote the price with the partner, record the order, start its fulfilment. Idempotent on the id. */
  async placeOrder(orderId: string, sku: string): Promise<{ orderId: string; priceCents: number }> {
    const existing = await this.env.DB.prepare("SELECT price_cents FROM orders WHERE order_id = ?1")
      .bind(orderId)
      .first<{ price_cents: number }>();
    if (existing) {
      await ensureFulfilment(this.env, orderId);
      return { orderId, priceCents: existing.price_cents };
    }
    const { priceCents } = await this.env.PARTNER.quote(sku);
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO orders (order_id, sku, price_cents, status) VALUES (?1, ?2, ?3, 'placed')",
    )
      .bind(orderId, sku, priceCents)
      .run();
    await ensureFulfilment(this.env, orderId);
    return { orderId, priceCents };
  }

  /**
   * The partner confirms a shipment: the order's fulfilment gets its event. A
   * confirmation resent after a lost answer finds the order shipped already
   * and is acknowledged, not sent again to a fulfilment that has completed.
   */
  async confirmShipment(
    orderId: string,
    trackingId: string,
  ): Promise<{ orderId: string; delivered: boolean }> {
    const order = await this.env.DB.prepare("SELECT status FROM orders WHERE order_id = ?1")
      .bind(orderId)
      .first<{ status: string }>();
    if (order?.status === "shipped") return { orderId, delivered: true };
    await ensureFulfilment(this.env, orderId);
    const instance = await this.env.FULFILMENT.get(orderId);
    await instance.sendEvent({ type: "shipped", payload: { trackingId } });
    return { orderId, delivered: true };
  }
}

export default {
  /** Reconciliation: orders still placed are checked with the partner; a shipment it knows of becomes the event. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const placed = await env.DB.prepare(
      "SELECT order_id FROM orders WHERE status = 'placed' ORDER BY order_id",
    ).all<{
      order_id: string;
    }>();
    for (const row of placed.results) {
      const shipment = await env.PARTNER.shipment(row.order_id);
      if (!shipment) continue;
      await ensureFulfilment(env, row.order_id);
      const instance = await env.FULFILMENT.get(row.order_id);
      await instance.sendEvent({ type: "shipped", payload: { trackingId: shipment.trackingId } });
    }
  },
} satisfies ExportedHandler<Env>;
