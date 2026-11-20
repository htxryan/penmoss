-- Installs of the apps in the period by window size class (compact, medium, expanded).
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH installs AS (
  SELECT day, install, client, actor, version, channel, os, os_version, size_class
  FROM daily_installs
  WHERE day > date(?6, '-' || ?1 || ' days') AND day <= ?6
  UNION
  -- Days the nightly rollup hasn't reached yet, from the events themselves.
  SELECT day, install, client, actor, version, channel, os, os_version, size_class
  FROM events
  WHERE day > (SELECT COALESCE(MAX(day), '') FROM daily_installs) AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6
)
SELECT client, COALESCE(size_class, 'unknown') AS size_class, COUNT(DISTINCT install) AS installs
FROM installs
WHERE client IN ('mac', 'android') AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY client, 2
ORDER BY client, installs DESC;
