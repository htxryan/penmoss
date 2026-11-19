-- Events per day by actor: a person, an agent or a script.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH counts AS (
  SELECT day, actor, events FROM daily_counts
  WHERE day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
  UNION ALL
  -- Days the nightly rollup hasn't reached yet, from the events themselves.
  SELECT day, actor, 1 FROM events
  WHERE day > (SELECT COALESCE(MAX(day), '') FROM daily_counts) AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
)
SELECT day, actor, SUM(events) AS events
FROM counts
GROUP BY day, actor
ORDER BY day, actor;
