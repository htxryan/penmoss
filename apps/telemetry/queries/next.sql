-- Paths: in sessions of the period (at most the last 90 days) with the start event, what came
-- next, three steps deep. Depth 0 is the start itself, then each step's events ('end' when the
-- session ended). A path seen in fewer than 5 sessions is never shown.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
-- ?7 the start event's kind, ?8 its name.
WITH sessions AS (
  SELECT DISTINCT install, session FROM events
  WHERE kind = ?7 AND name = ?8 AND day > date(?6, '-' || MIN(?1, 90) || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
steps AS (
  SELECT events.install || ':' || events.session AS session,
    events.kind || ':' || events.name AS event,
    LEAD(events.kind || ':' || events.name, 1) OVER w AS n1,
    LEAD(events.kind || ':' || events.name, 2) OVER w AS n2,
    LEAD(events.kind || ':' || events.name, 3) OVER w AS n3
  FROM events
  JOIN sessions ON sessions.install = events.install AND sessions.session = events.session
  WINDOW w AS (PARTITION BY events.install, events.session ORDER BY events.seq)
),
hits AS (
  SELECT session,
    COALESCE(n1, 'end') AS n1,
    CASE WHEN n1 IS NULL THEN NULL ELSE COALESCE(n2, 'end') END AS n2,
    CASE WHEN n1 IS NULL OR n2 IS NULL THEN NULL ELSE COALESCE(n3, 'end') END AS n3
  FROM steps
  WHERE event = ?7 || ':' || ?8
)
SELECT 0 AS depth, '' AS n1, '' AS n2, '' AS n3, COUNT(DISTINCT session) AS sessions
FROM hits HAVING COUNT(DISTINCT session) >= 5
UNION ALL
SELECT 1, n1, '', '', COUNT(DISTINCT session) FROM hits
GROUP BY n1 HAVING COUNT(DISTINCT session) >= 5
UNION ALL
SELECT 2, n1, n2, '', COUNT(DISTINCT session) FROM hits WHERE n2 IS NOT NULL
GROUP BY n1, n2 HAVING COUNT(DISTINCT session) >= 5
UNION ALL
SELECT 3, n1, n2, n3, COUNT(DISTINCT session) FROM hits WHERE n3 IS NOT NULL
GROUP BY n1, n2, n3 HAVING COUNT(DISTINCT session) >= 5
ORDER BY depth, sessions DESC;
