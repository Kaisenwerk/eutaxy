-- One row per code sent; the limit is meant to allow one per email per minute.
CREATE TABLE code_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
