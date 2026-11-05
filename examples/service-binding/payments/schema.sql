CREATE TABLE charges (
  charge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
