-- One row per attachment the app knows about; object_key names its R2 object.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE
);
