-- Active installs today, in the last 7 days and in the last 30 (the period itself is ignored).
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH installs AS (
  SELECT day, install, client, actor, version, channel FROM daily_installs
  WHERE day > date(?6, '-30 days') AND day <= ?6
  UNION
  SELECT day, install, client, actor, version, channel FROM events
  WHERE day > (SELECT COALESCE(MAX(day), '') FROM daily_installs)
    AND day > date(?6, '-30 days') AND day <= ?6
)
SELECT
  COUNT(DISTINCT CASE WHEN day = ?6 THEN install END) AS today,
  COUNT(DISTINCT CASE WHEN day > date(?6, '-7 days') THEN install END) AS last7,
  COUNT(DISTINCT install) AS last30
FROM installs
WHERE (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5);
