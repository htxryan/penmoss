-- Usage analytics' D1 database (PEN-137): the events shared installs send, the nightly
-- rollups the dashboard reads, the catalogue of names, and the Worker's own daily counts.
-- No column holds an IP address, a note's text or anything typed: an event's name is a
-- catalogue id and its props are enums, booleans and buckets (core's validate.ts).

-- One row per event received, kept 13 months (the nightly cron prunes older days).
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  -- The event's UTC day (YYYY-MM-DD), from its time, never later than when it arrived.
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  session TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  client TEXT NOT NULL,
  actor TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT NOT NULL,
  size_class TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}'
);
-- A batch sent again (a lost answer, a retry) adds no rows: INSERT OR IGNORE on this key. It
-- also orders a session's events for Paths and finds an install's rows for a forget, so there
-- is no second index on the same columns.
CREATE UNIQUE INDEX events_key ON events (install, session, seq);
CREATE INDEX events_day_name ON events (day, kind, name);

-- Events per day by what the dashboard filters and groups on, kept 25 months. `source` is a
-- command's props.source, and '' for every other kind.
CREATE TABLE daily_counts (
  day TEXT NOT NULL,
  client TEXT NOT NULL,
  actor TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  events INTEGER NOT NULL,
  PRIMARY KEY (day, client, actor, version, channel, kind, name, source)
);
-- "Never Used" looks a name up across days.
CREATE INDEX daily_counts_name ON daily_counts (kind, name, day);

-- Which installs were active each day, kept 25 months; Delete My Shared Data deletes an
-- install's rows here too.
CREATE TABLE daily_installs (
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  client TEXT NOT NULL,
  actor TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT NOT NULL,
  size_class TEXT,
  PRIMARY KEY (day, install, client, actor)
);
CREATE INDEX daily_installs_install ON daily_installs (install);

-- Every name an event may carry (core's CATALOGUE), refreshed nightly: "Never Used".
CREATE TABLE catalogue (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

-- The ingest Worker's own counts per UTC day: the Health view.
CREATE TABLE ingest_daily (
  day TEXT PRIMARY KEY,
  batches INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  dropped INTEGER DEFAULT 0,
  forgets INTEGER DEFAULT 0,
  -- Rows the batches added (a retried batch adds none).
  written INTEGER DEFAULT 0
);
