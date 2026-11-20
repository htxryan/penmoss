-- Paths' start events: how often each kind and name occurred in the period (at most the last 90
-- days), most first, for the Start From field. Scroll events are left out (PEN-175): where an area
-- rests is not a step anyone takes from.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT kind, name, COUNT(*) AS events
FROM events
WHERE kind <> 'scroll' AND day > date(?6, '-' || MIN(?1, 90) || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY kind, name
ORDER BY events DESC, kind, name;
