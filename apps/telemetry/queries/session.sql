-- One session (PEN-173): every event of install ?9's session ?10 in the last 90 days, whatever
-- the period or the filters, in seq order. At most 5,001 rows: the page shows 5,000 and says
-- when there were more.
-- Parameters: ?6 today (YYYY-MM-DD, UTC), ?9 the install, ?10 the session. ?1 to ?5 are not used.
SELECT seq, at, client, actor, version, channel, os, os_version, size_class, kind, name, props
FROM events
WHERE install = ?9 AND session = ?10 AND day > date(?6, '-90 days') AND day <= ?6
ORDER BY seq
LIMIT 5001;
