CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY
);
