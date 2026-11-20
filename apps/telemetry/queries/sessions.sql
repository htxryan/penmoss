-- Sessions (PEN-173): the sessions with at least one event in the period (at most the last 90
-- days) that matches every filter, newest first, 50 a page. Each row is worked out from all of
-- the session's events inside that window: its start and end, how many events, the duration
-- bucket of a one-event session, the client, version and OS of its first event, its first and
-- last screen, and how many sessions match in all.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC). ?7 to ?10 are not used.
-- ?11 the page, from 1.
WITH matched AS (
  SELECT DISTINCT install, session FROM events
  WHERE day > date(?6, '-' || MIN(?1, 90) || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
per AS (
  SELECT events.install, events.session,
    MIN(events.at) AS started,
    MAX(events.at) AS ended,
    COUNT(*) AS events,
    MIN(events.seq) AS first_seq,
    MIN(CASE WHEN events.kind = 'screen' THEN events.seq END) AS first_screen_seq,
    MAX(CASE WHEN events.kind = 'screen' THEN events.seq END) AS last_screen_seq
  FROM events
  JOIN matched ON matched.install = events.install AND matched.session = events.session
  WHERE events.day > date(?6, '-' || MIN(?1, 90) || ' days') AND events.day <= ?6
  GROUP BY events.install, events.session
)
SELECT per.install, per.session, per.started, per.ended, per.events,
  CASE WHEN per.events = 1 THEN json_extract(opening.props, '$.took') END AS took,
  opening.client, opening.version, opening.os, opening.os_version,
  first_screen.name AS first_screen,
  last_screen.name AS last_screen,
  COUNT(*) OVER () AS total
FROM per
JOIN events AS opening
  ON opening.install = per.install AND opening.session = per.session AND opening.seq = per.first_seq
LEFT JOIN events AS first_screen
  ON first_screen.install = per.install AND first_screen.session = per.session
  AND first_screen.seq = per.first_screen_seq
LEFT JOIN events AS last_screen
  ON last_screen.install = per.install AND last_screen.session = per.session
  AND last_screen.seq = per.last_screen_seq
ORDER BY per.started DESC, per.install, per.session
LIMIT 50 OFFSET (?11 - 1) * 50;
