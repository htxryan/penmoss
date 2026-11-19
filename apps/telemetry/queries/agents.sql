-- CLI commands and MCP tools in the period, by who ran them (an MCP tool's agent client, else
-- the actor), with how many calls succeeded.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT kind, name,
  COALESCE(json_extract(props, '$.agentClient'), actor) AS agent,
  COUNT(*) AS calls,
  SUM(CASE WHEN json_extract(props, '$.result') = 'ok' OR json_extract(props, '$.exit') = 'OK'
    THEN 1 ELSE 0 END) AS ok,
  COUNT(DISTINCT install) AS installs
FROM events
WHERE kind IN ('cli', 'tool') AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
GROUP BY kind, name, agent
ORDER BY calls DESC, kind, name, agent;
