/**
 * The effect log: the complete, ordered record of what a simulated run did at
 * its effect boundaries. It is plain data, appended immutably, and has one
 * canonical serialisation, so two runs are identical exactly when their
 * serialised logs are byte-identical.
 */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import { utf8Encode } from "./utf8.ts";

/** `snapshot` records platform state (e.g. D1 tables) captured at the end of a run; it is not an effect point. */
export type EffectKind = "call" | "result" | "fault" | "snapshot";

export interface EffectRecord {
  /** Position in the log, dense from 0. */
  readonly seq: number;
  readonly kind: EffectKind;
  /** The invocation (request, message, alarm) this effect belongs to. */
  readonly invocation: string;
  /** The binding or global the effect went through, e.g. "D1:DB". */
  readonly target: string;
  /** The operation, e.g. "run", "batch", "send". */
  readonly op: string;
  /** Operation-specific data: arguments, results, or the injected fault. */
  readonly payload: JsonValue;
}

export interface EffectLog {
  readonly entries: readonly EffectRecord[];
}

export const emptyLog: EffectLog = Object.freeze({ entries: Object.freeze([]) });

/** Append one effect, assigning its sequence number. The input log is unchanged. */
export function appendEffect(log: EffectLog, effect: Omit<EffectRecord, "seq">): EffectLog {
  const record: EffectRecord = { ...effect, seq: log.entries.length };
  return { entries: [...log.entries, record] };
}

/** One canonical JSON object per line, in sequence order. */
export function serializeLog(log: EffectLog): string {
  return log.entries
    .map((e) =>
      canonicalJson({
        seq: e.seq,
        kind: e.kind,
        invocation: e.invocation,
        target: e.target,
        op: e.op,
        payload: e.payload,
      }),
    )
    .join("\n");
}

/** A 64-bit FNV-1a digest of the serialised log, as 16 hex digits. Not cryptographic. */
export function digestLog(log: EffectLog): string {
  const bytes = utf8Encode(serializeLog(log));
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
