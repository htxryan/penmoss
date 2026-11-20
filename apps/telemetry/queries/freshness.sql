-- How fresh the data is: when the newest event was received (ms) and the last day the nightly
-- rollup reached. The period and filters don't apply.
SELECT
  (SELECT MAX(received_at) FROM events) AS received_at,
  (SELECT MAX(day) FROM daily_counts) AS rolled_up_through;
