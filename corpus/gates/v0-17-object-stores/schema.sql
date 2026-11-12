CREATE TABLE settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO settings (key, value) VALUES ('max_bytes', 16);
CREATE TABLE catalogue (name TEXT PRIMARY KEY, size INTEGER NOT NULL);
