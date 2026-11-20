-- Send Feedback in the period: reports by type and priority, and how many attached logs.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT client,
  COALESCE(json_extract(props, '$.type'), '') AS type,
  COALESCE(json_extract(props, '$.priority'), 0) AS priority,
  COUNT(*) AS reports,
  SUM(CASE WHEN json_extract(props, '$.logs') = 1 THEN 1 ELSE 0 END) AS with_logs
FROM events
WHERE kind = 'feedback' AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY 1, 2, 3
ORDER BY reports DESC, client, type, priority;
