CREATE TABLE replies (
  request_id TEXT PRIMARY KEY,
  reply TEXT NOT NULL,
  via TEXT NOT NULL
);

-- The notices the turns Worker sent, as this Worker took them: one per request, by the handler's care.
CREATE TABLE notices (
  request_id TEXT NOT NULL,
  reply TEXT NOT NULL
);
