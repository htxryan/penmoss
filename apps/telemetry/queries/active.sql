-- Weekly active installs by client: for each day of the period, how many installs did anything
-- in the 7 days up to it.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH RECURSIVE days(day) AS (
  SELECT date(?6, '-' || (?1 - 1) || ' days')
  UNION ALL
  SELECT date(day, '+1 day') FROM days WHERE day < ?6
),
installs AS (
  SELECT day, install, client, actor, version, channel FROM daily_installs
  WHERE day > date(?6, '-' || (?1 + 6) || ' days') AND day <= ?6
  UNION
  SELECT day, install, client, actor, version, channel FROM events
  WHERE day > (SELECT COALESCE(MAX(day), '') FROM daily_installs)
    AND day > date(?6, '-' || (?1 + 6) || ' days') AND day <= ?6
)
SELECT days.day AS day, installs.client AS client, COUNT(DISTINCT installs.install) AS installs
FROM days
JOIN installs ON installs.day > date(days.day, '-7 days') AND installs.day <= days.day
WHERE (?2 = '' OR installs.client = ?2) AND (?3 = '' OR installs.actor = ?3)
  AND (?4 = '' OR installs.channel = ?4) AND (?5 = '' OR installs.version = ?5)
GROUP BY days.day, installs.client
ORDER BY days.day, installs.client;
