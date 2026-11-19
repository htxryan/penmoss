-- Installs by app version in the period, most first.
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
SELECT version, COUNT(DISTINCT install) AS installs
FROM installs
WHERE (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY version
ORDER BY installs DESC, version DESC;
