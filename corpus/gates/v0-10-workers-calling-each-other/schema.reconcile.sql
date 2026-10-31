CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  tracking_id TEXT
);
INSERT INTO orders (order_id, sku, price_cents, status) VALUES ('o-7', 'sku-1', 1200, 'placed');
INSERT INTO orders (order_id, sku, price_cents, status) VALUES ('o-8', 'sku-2', 500, 'placed');
