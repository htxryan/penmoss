-- Git notebook sync passes in the period: how each ended and how long it took.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT client,
  COALESCE(json_extract(props, '$.result'), '') AS result,
  COALESCE(json_extract(props, '$.took'), '') AS took,
  COUNT(*) AS passes,
  COUNT(DISTINCT install) AS installs
FROM events
WHERE kind = 'sync' AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY 1, 2, 3
ORDER BY passes DESC, client, result, took;
