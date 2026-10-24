/**
 * A wallet in a Durable Object: a withdrawal checks the balance, pays out
 * through an external payouts API, then debits.
 *
 * Planted bug: the check and the debit are separated by the payout call.
 * A Durable Object's input gate holds other events only during storage
 * operations, not during outbound fetch, so a second withdrawal can run
 * while the first awaits its payout: both see the full balance, both pay
 * out, and the balance goes negative. The fix reserves the amount before
 * paying out, so the second withdrawal sees what is left.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  readonly WALLET: DurableObjectNamespace<Wallet>;
}

export interface Withdrawal {
  readonly ok: boolean;
  readonly balance: number;
}

export class Wallet extends DurableObject<Env> {
  async withdraw(amount: number): Promise<Withdrawal> {
    const balance = (await this.ctx.storage.get<number>("balance")) ?? 0;
    if (balance < amount) return { ok: false, balance };
    await this.payOut(amount);
    const now = (await this.ctx.storage.get<number>("balance")) ?? 0;
    await this.ctx.storage.put("balance", now - amount);
    return { ok: true, balance: now - amount };
  }

  protected async payOut(amount: number): Promise<void> {
    const res = await fetch("https://payouts.example/payouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) throw new Error(`payout failed with ${res.status}`);
  }
}

/** The fix: reserve the amount before paying out, and give it back if the payout fails. */
export class FixedWallet extends Wallet {
  override async withdraw(amount: number): Promise<Withdrawal> {
    const balance = (await this.ctx.storage.get<number>("balance")) ?? 0;
    if (balance < amount) return { ok: false, balance };
    await this.ctx.storage.put("balance", balance - amount);
    try {
      await this.payOut(amount);
    } catch (err) {
      const now = (await this.ctx.storage.get<number>("balance")) ?? 0;
      await this.ctx.storage.put("balance", now + amount);
      throw err;
    }
    return { ok: true, balance: balance - amount };
  }
}

/** Another fix: hold the input gate for the whole withdrawal, so no other event runs meanwhile. */
export class GatedWallet extends Wallet {
  override async withdraw(amount: number): Promise<Withdrawal> {
    return this.ctx.blockConcurrencyWhile(() => super.withdraw(amount));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/withdraw") {
      return new Response("not found", { status: 404 });
    }
    const { amount } = (await request.json()) as { amount: number };
    const result = await env.WALLET.getByName("alice").withdraw(amount);
    return Response.json(result, { status: result.ok ? 200 : 402 });
  },
} satisfies ExportedHandler<Env>;
