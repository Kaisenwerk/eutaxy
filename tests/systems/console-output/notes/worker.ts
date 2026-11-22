/** The notes Worker: it refuses a note with no text, and says why on the console. */

import { WorkerEntrypoint } from "cloudflare:workers";

export default class Notes extends WorkerEntrypoint {
  async record(id: string, text: string): Promise<{ ok: boolean }> {
    if (text === "") {
      console.warn(`notes: refused ${id}: a note needs text`);
      return { ok: false };
    }
    console.log(`notes: recorded ${id}`);
    return { ok: true };
  }
}
