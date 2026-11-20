-- The ingest Worker's own counts per day: batches, events accepted and dropped, rows written
-- (a retried batch writes none), and forgets. Filters other than the period don't apply.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT day, batches, accepted, dropped, written, forgets
FROM ingest_daily
WHERE day > date(?6, '-' || ?1 || ' days') AND day <= ?6
ORDER BY day;
