-- This install's sessions (PEN-173): install ?9's sessions in the last 90 days, whatever the
-- filters, numbered oldest first; the 500 nearest session ?10 in that order are kept (a tie goes
-- to the older), then listed oldest first. `total` counts every session of the install in the 90
-- days, before the cut.
-- Parameters: ?6 today (YYYY-MM-DD, UTC), ?9 the install, ?10 the open session. ?1 to ?5 are
-- not used.
WITH per AS (
  SELECT session,
    MIN(at) AS started,
    MAX(at) AS ended,
    COUNT(*) AS events,
    MIN(seq) AS first_seq
  FROM events
  WHERE install = ?9 AND day > date(?6, '-90 days') AND day <= ?6
  GROUP BY session
),
numbered AS (
  SELECT per.*,
    ROW_NUMBER() OVER (ORDER BY started, session) AS n,
    COUNT(*) OVER () AS total
  FROM per
),
target AS (
  SELECT n FROM numbered WHERE session = ?10
),
kept AS (
  SELECT numbered.* FROM numbered, target
  ORDER BY ABS(numbered.n - target.n), numbered.n
  LIMIT 500
)
SELECT kept.session, kept.started, kept.ended, kept.events,
  CASE WHEN kept.events = 1 THEN json_extract(opening.props, '$.took') END AS took,
  opening.client,
  kept.total
FROM kept
JOIN events AS opening ON opening.install = ?9 AND opening.session = kept.session AND opening.seq = kept.first_seq
ORDER BY kept.started, kept.session;
