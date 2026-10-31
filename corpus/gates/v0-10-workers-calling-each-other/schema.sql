CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  tracking_id TEXT
);
