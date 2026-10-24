CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  captured_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0
);
INSERT INTO orders (id, captured_cents, refunded_cents) VALUES ('o-1', 1000, 0);
