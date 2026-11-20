-- Installs by main window size (app window events, PEN-174): the 10 sizes most installs recorded
-- per client, the Mac and Android only, then Other. A size fewer than 5 installs recorded is
-- never shown on its own (A1641's floor on small counts): it goes into Other with the rest.
-- Sizes are as recorded (CSS px or dp, to 10), portrait and landscape apart. Read from the events
-- (kept 13 months): no rollup holds props. Other's width and height are NULL.
-- Parameters: ?1 days (the period ends today and is this many days long), ?2 client, ?3 actor,
-- ?4 channel, ?5 version ('' for all), ?6 today (YYYY-MM-DD, UTC).
WITH sized AS (
  SELECT client, install,
    CAST(json_extract(props, '$.width') AS INTEGER) AS width,
    CAST(json_extract(props, '$.height') AS INTEGER) AS height
  FROM events
  WHERE kind = 'app' AND name = 'window' AND json_extract(props, '$.window') = 'main'
    AND client IN ('mac', 'android')
    AND day > date(?6, '-' || ?1 || ' days') AND day <= ?6
    AND (?2 = '' OR client = ?2) AND (?3 = '' OR actor = ?3)
    AND (?4 = '' OR channel = ?4) AND (?5 = '' OR version = ?5)
),
sizes AS (
  SELECT client, width, height, COUNT(DISTINCT install) AS installs,
    ROW_NUMBER() OVER (
      PARTITION BY client ORDER BY COUNT(DISTINCT install) DESC, width DESC, height DESC
    ) AS place
  FROM sized
  GROUP BY client, width, height
),
shown AS (
  SELECT client, width, height, installs FROM sizes WHERE installs >= 5 AND place <= 10
)
SELECT client, width, height, installs
FROM (
  SELECT client, width, height, installs, 0 AS other FROM shown
  UNION ALL
  SELECT sized.client, NULL, NULL, COUNT(DISTINCT sized.install), 1
  FROM sized
  LEFT JOIN shown
    ON shown.client = sized.client AND shown.width = sized.width AND shown.height = sized.height
  WHERE shown.client IS NULL
  GROUP BY sized.client
)
ORDER BY client, other, installs DESC, width DESC, height DESC;
