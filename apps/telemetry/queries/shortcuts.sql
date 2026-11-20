-- Commands run from the keyboard: each combination, its runs, its share of the command's runs,
-- how many installs used it, and how many of those had set the combination themselves.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH runs AS (
  SELECT name, install,
    json_extract(props, '$.source') AS source,
    json_extract(props, '$.keys') AS keys,
    json_extract(props, '$.custom') AS custom
  FROM events
  WHERE kind = 'command' AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
totals AS (SELECT name, COUNT(*) AS runs FROM runs GROUP BY name)
SELECT runs.name AS name, runs.keys AS keys, COUNT(*) AS key_runs, totals.runs AS all_runs,
  ROUND(100.0 * COUNT(*) / totals.runs, 1) AS key_share,
  COUNT(DISTINCT runs.install) AS installs,
  COUNT(DISTINCT CASE WHEN runs.custom = 1 THEN runs.install END) AS rebound_installs
FROM runs
JOIN totals ON totals.name = runs.name
WHERE runs.source = 'key' AND runs.keys IS NOT NULL
GROUP BY runs.name, runs.keys
ORDER BY key_runs DESC, runs.name
LIMIT 50;
