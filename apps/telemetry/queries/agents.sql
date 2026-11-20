-- CLI commands and MCP tools in the period, by who ran them (an MCP tool's agent client, else
-- the actor), with how many calls ended in each result: ok, invalid, notFound, conflict, failed.
-- A CLI command's exit name maps to the same results: OK is ok, USAGE invalid, NOT_FOUND notFound,
-- CONFLICT conflict, and any other exit failed.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT kind, name,
  COALESCE(json_extract(props, '$.agentClient'), actor) AS agent,
  COUNT(*) AS calls,
  SUM(CASE WHEN result = 'ok' THEN 1 ELSE 0 END) AS ok,
  SUM(CASE WHEN result = 'invalid' THEN 1 ELSE 0 END) AS invalid,
  SUM(CASE WHEN result = 'notFound' THEN 1 ELSE 0 END) AS not_found,
  SUM(CASE WHEN result = 'conflict' THEN 1 ELSE 0 END) AS conflict,
  SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed,
  COUNT(DISTINCT install) AS installs
FROM (
  SELECT kind, name, props, actor, install,
    CASE
      WHEN kind = 'tool' THEN COALESCE(json_extract(props, '$.result'), 'failed')
      WHEN json_extract(props, '$.exit') = 'OK' THEN 'ok'
      WHEN json_extract(props, '$.exit') = 'USAGE' THEN 'invalid'
      WHEN json_extract(props, '$.exit') = 'NOT_FOUND' THEN 'notFound'
      WHEN json_extract(props, '$.exit') = 'CONFLICT' THEN 'conflict'
      ELSE 'failed'
    END AS result
  FROM events
  WHERE kind IN ('cli', 'tool') AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
)
GROUP BY kind, name, agent
ORDER BY calls DESC, kind, name, agent;
