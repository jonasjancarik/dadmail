-- Error reports from DadMail. Apply with:
--   cf d1 raw 6db4efc3-be81-46b4-8da8-5def48336566 --sql "$(cat schema.sql)"
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  -- A random ID per installation, so reports from one PC can be grouped
  install_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  -- How many times the app saw this error before sending (repeats are collapsed on the device)
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_reports_received ON reports (received_at);
CREATE INDEX IF NOT EXISTS idx_reports_install ON reports (install_id, received_at);
