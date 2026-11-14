CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  available_after INTEGER NOT NULL
);
