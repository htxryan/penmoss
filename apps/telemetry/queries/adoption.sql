-- Version adoption: installs active each day by app version, the 6 versions with most installs
-- in the period and the rest as Other.
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
),
scoped AS (SELECT day, install, version FROM installs WHERE (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)),
top AS (
  SELECT version FROM scoped GROUP BY version
  ORDER BY COUNT(DISTINCT install) DESC, version DESC LIMIT 6
)
SELECT day,
  CASE WHEN version IN (SELECT version FROM top) THEN version ELSE 'Other' END AS version,
  COUNT(DISTINCT install) AS installs
FROM scoped
GROUP BY day, 2
ORDER BY day, 2;
