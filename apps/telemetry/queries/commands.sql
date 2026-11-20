-- The 25 commands run most in the period, each split by where it was run from (source: key,
-- palette, button, menu, tray, hotkey, editor), with how many installs ran it.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH counts AS (
  SELECT name, source, events FROM daily_counts
  WHERE kind = 'command' AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
  UNION ALL
  -- Days the nightly rollup hasn't reached yet, from the events themselves.
  SELECT name, COALESCE(json_extract(props, '$.source'), ''), 1 FROM events
  WHERE kind = 'command' AND day > (SELECT COALESCE(MAX(day), '') FROM daily_counts)
    AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
top AS (
  SELECT name, SUM(events) AS runs FROM counts GROUP BY name ORDER BY runs DESC, name LIMIT 25
),
reach AS (
  SELECT name, COUNT(DISTINCT install) AS installs FROM events
  WHERE kind = 'command' AND name IN (SELECT name FROM top) AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
  GROUP BY name
)
SELECT counts.name AS name, counts.source AS source, SUM(counts.events) AS runs,
  top.runs AS total, COALESCE(reach.installs, 0) AS installs
FROM counts
JOIN top ON top.name = counts.name
LEFT JOIN reach ON reach.name = counts.name
GROUP BY counts.name, counts.source
ORDER BY total DESC, counts.name, runs DESC;
