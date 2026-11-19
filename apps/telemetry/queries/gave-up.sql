-- Installs that began the first run in the period (at most the last 90 days) and never finished
-- it (no Set Up done, no answer to the consent question), by the last step they reached and how
-- that step ended.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH steps AS (
  SELECT install, client, name, at, seq,
    json_extract(props, '$.result') AS result,
    json_extract(props, '$.error') AS error
  FROM events
  WHERE kind = 'firstrun' AND day > date(?6, '-' || MIN(?1, 90) || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
finished AS (
  SELECT DISTINCT install FROM steps
  WHERE name = 'consent' OR (name = 'setup' AND result = 'done')
),
last AS (
  SELECT client, name, result, error,
    ROW_NUMBER() OVER (PARTITION BY install ORDER BY at DESC, seq DESC) AS latest
  FROM steps
  WHERE install NOT IN (SELECT install FROM finished)
)
SELECT name AS step, client, COALESCE(result, '') AS result, COALESCE(error, '') AS error,
  COUNT(*) AS installs
FROM last
WHERE latest = 1
GROUP BY name, client, result, error
ORDER BY installs DESC, step;
