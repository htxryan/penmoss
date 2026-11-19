-- The first run: how many installs reached each step in the period (at most the last 90 days),
-- by client, and how many of them finished that step.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT name AS step, client,
  COUNT(DISTINCT install) AS installs,
  COUNT(DISTINCT CASE WHEN json_extract(props, '$.result') = 'done' THEN install END) AS done
FROM events
WHERE kind = 'firstrun' AND day > date(?6, '-' || MIN(?1, 90) || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY name, client
ORDER BY name, client;
