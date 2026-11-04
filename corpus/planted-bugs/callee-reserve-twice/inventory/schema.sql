CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL
);
