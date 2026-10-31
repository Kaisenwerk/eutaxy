CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO dispatches (id, payload, status) VALUES ('d-1', 'invoice 1', 'pending');
INSERT INTO dispatches (id, payload, status) VALUES ('d-2', 'invoice 2', 'pending');
