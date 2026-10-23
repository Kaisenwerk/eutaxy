-- One lease per subscription; `until` is the virtual time it expires.
CREATE TABLE leases (
  subscription TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
CREATE TABLE applied_events (
  event_id TEXT PRIMARY KEY
);
