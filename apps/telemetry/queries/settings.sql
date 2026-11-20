-- Settings changed in the period: each setting and the value chosen ('changed' for a text
-- setting, whose value is never recorded), how often, and by how many installs.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT name,
  CASE
    WHEN json_type(props, '$.value') IS NULL THEN 'changed'
    WHEN json_type(props, '$.value') IN ('true', 'false') THEN json_type(props, '$.value')
    ELSE CAST(json_extract(props, '$.value') AS TEXT)
  END AS value,
  COUNT(*) AS changes,
  COUNT(DISTINCT install) AS installs
FROM events
WHERE kind = 'setting' AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY 1, 2
ORDER BY changes DESC, name, value;
