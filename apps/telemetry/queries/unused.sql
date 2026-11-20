-- Catalogued names nothing used in the period: commands, controls, dialogs, screens, menus,
-- settings, CLI commands and MCP tools.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
SELECT kind, name
FROM catalogue
WHERE kind IN ('command', 'click', 'dialog', 'screen', 'menu', 'setting', 'cli', 'tool')
  AND NOT EXISTS (
    SELECT 1 FROM daily_counts
    WHERE daily_counts.kind = catalogue.kind AND daily_counts.name = catalogue.name
      AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
  )
  AND NOT EXISTS (
    SELECT 1 FROM events
    WHERE events.kind = catalogue.kind AND events.name = catalogue.name
      AND day > (SELECT COALESCE(MAX(day), '') FROM daily_counts) AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6 AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
  )
ORDER BY kind, name;
