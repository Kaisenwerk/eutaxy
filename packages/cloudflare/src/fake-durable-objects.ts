/**
 * Test doubles for Durable Object storage, for the platform's Node tests:
 * one storage object per instance (a new instance gets a new one, as in
 * workerd) over backing data shared by every instance of the object.
 */

/** An object's durable state, shared by every instance of it, like the runtime's storage. */
export class Backing {
  readonly data = new Map<string, unknown>();
  /** How many times a transaction runs its callback (the runtime may retry it after a conflict). */
  transactionAttempts = 1;
  realAlarmSets = 0;
  realAlarm: number | null = null;
}

/**
 * A minimal stand-in for DurableObjectStorage: one per instance (a new
 * instance gets a new storage object, as in workerd), over shared backing.
 */
export class FakeStorage {
  readonly backing: Backing;
  constructor(backing: Backing) {
    this.backing = backing;
  }
  async get(key: string) {
    return structuredClone(this.backing.data.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === "string") this.backing.data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.backing.data.set(k, structuredClone(v));
  }
  async list() {
    return new Map([...this.backing.data].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  async deleteAll() {
    this.backing.data.clear();
  }
  async setAlarm(time: number) {
    this.backing.realAlarmSets++;
    this.backing.realAlarm = time;
  }
  async getAlarm() {
    return this.backing.realAlarm;
  }
  async deleteAlarm() {
    this.backing.realAlarm = null;
  }
  /** Writes inside the callback are undone when it throws or calls `rollback()`. */
  async transaction<T>(callback: (txn: FakeStorage & { rollback(): void }) => Promise<T>) {
    const before = new Map(this.backing.data);
    for (let attempt = 1; ; attempt++) {
      let rolledBack = false;
      const txn = Object.assign(Object.create(this) as FakeStorage, {
        rollback: () => {
          rolledBack = true;
        },
      });
      try {
        const result = await callback(txn);
        // An earlier attempt is discarded as if it had conflicted.
        if (rolledBack || attempt < this.backing.transactionAttempts) this.restore(before);
        if (attempt < this.backing.transactionAttempts && !rolledBack) continue;
        return result;
      } catch (err) {
        this.restore(before);
        throw err;
      }
    }
  }
  /** SQLite-backed storage's synchronous transaction: undone when the callback throws. */
  transactionSync<T>(callback: () => T): T {
    const before = new Map(this.backing.data);
    try {
      return callback();
    } catch (err) {
      this.restore(before);
      throw err;
    }
  }
  private restore(data: Map<string, unknown>) {
    this.backing.data.clear();
    for (const [k, v] of data) this.backing.data.set(k, v);
  }
}
