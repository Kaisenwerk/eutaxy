/**
 * Test doubles for Durable Object storage, for the platform's Node tests:
 * one storage object per instance (a new instance gets a new one, as in
 * workerd) over backing data shared by every instance of the object.
 */

/** An object's durable state, shared by every instance of it, like the runtime's storage. */
export class Backing {
  readonly data = new Map<string, unknown>();
  /** SQL tables by name, when the object is SQLite-backed (`sqlite` set); the statements run, for assertions. */
  readonly tables = new Map<string, Record<string, unknown>[]>();
  readonly statements: string[] = [];
  sqlite = true;
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
  readonly sql: FakeSql;
  constructor(backing: Backing) {
    this.backing = backing;
    this.sql = new FakeSql(backing);
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
    this.backing.tables.clear();
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

/**
 * A stand-in for `ctx.storage.sql` that takes the statements the seed, the
 * snapshot and a test object use: `CREATE TABLE`, `INSERT`, `UPDATE … SET
 * col = col - ? WHERE col = ? AND col >= ?`, `SELECT * FROM t`, and the
 * `sqlite_master` query, with `?` bindings. Anything else throws, as a
 * reminder that this is not SQLite. Unavailable (throws) when the backing
 * is not SQLite-backed, as the runtime's is on a key-value object.
 */
export class FakeSql {
  readonly backing: Backing;
  constructor(backing: Backing) {
    this.backing = backing;
  }
  exec(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): Record<string, unknown>[]; rowsWritten: number } {
    if (!this.backing.sqlite) throw new Error("SQL is not enabled for this Durable Object class");
    const q = query.trim().replace(/;$/, "");
    this.backing.statements.push(q);
    const rows = (r: Record<string, unknown>[], written = 0) => ({
      toArray: () => r,
      rowsWritten: written,
    });
    if (q === "SELECT 1") return rows([{ "1": 1 }]);
    if (q.startsWith("SELECT name FROM sqlite_master"))
      return rows([...this.backing.tables.keys()].sort().map((name) => ({ name })));
    const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1");
    let m = /^CREATE TABLE (?:IF NOT EXISTS )?("?[\w]+"?)\s*\(/i.exec(q);
    if (m) {
      // A schema may hold several statements: create each table it names.
      for (const c of q.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?("?[\w]+"?)\s*\(/gi))
        if (!this.backing.tables.has(unquote(c[1] as string)))
          this.backing.tables.set(unquote(c[1] as string), []);
      return rows([]);
    }
    m = /^INSERT INTO ("?[\w]+"?) DEFAULT VALUES$/i.exec(q);
    if (m) {
      const table = this.backing.tables.get(unquote(m[1] as string));
      if (!table) throw new Error(`no such table: ${m[1]}`);
      table.push({});
      return rows([], 1);
    }
    m = /^INSERT INTO ("?[\w]+"?) \(([^)]*)\) VALUES \(([^)]*)\)$/i.exec(q);
    if (m) {
      const table = this.backing.tables.get(unquote(m[1] as string));
      if (!table) throw new Error(`no such table: ${m[1]}`);
      const columns = (m[2] as string).split(",").map((c) => unquote(c.trim()));
      const row: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        row[c] = bindings[i];
      });
      table.push(row);
      return rows([], 1);
    }
    m = /^SELECT \* FROM ("?[\w]+"?)(?: WHERE ("?\w+"?) = \?)?$/i.exec(q);
    if (m) {
      const table = this.backing.tables.get(unquote(m[1] as string)) ?? [];
      const col = m[2] === undefined ? undefined : unquote(m[2]);
      return rows(
        table.filter((r) => col === undefined || r[col] === bindings[0]).map((r) => ({ ...r })),
      );
    }
    m =
      /^UPDATE ("?[\w]+"?) SET ("?\w+"?) = ("?\w+"?) - \? WHERE ("?\w+"?) = \?(?: AND ("?\w+"?) >= \?)?$/i.exec(
        q,
      );
    if (m) {
      const table = this.backing.tables.get(unquote(m[1] as string)) ?? [];
      const [col, by, keyCol, guard] = [
        unquote(m[2] as string),
        unquote(m[3] as string),
        unquote(m[4] as string),
        m[5] === undefined ? undefined : unquote(m[5]),
      ];
      let written = 0;
      for (const r of table) {
        if (r[keyCol] !== bindings[1]) continue;
        if (guard !== undefined && (r[guard] as number) < (bindings[2] as number)) continue;
        r[col] = (r[by] as number) - (bindings[0] as number);
        written++;
      }
      return rows([], written);
    }
    throw new Error(`the fake SQL does not take: ${q}`);
  }
}
