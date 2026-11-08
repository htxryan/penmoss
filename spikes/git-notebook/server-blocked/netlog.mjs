#!/usr/bin/env node
// Summarises a Chromium net log (`--log-net-log=<file>`): every request to a penmoss.app host,
// when it started, and how it ended. No dependencies, so it runs anywhere Node does:
//
//   node spikes/git-notebook/server-blocked/netlog.mjs ~/Desktop/penmoss-netlog.json
//
// Outcomes: "completed", a net error (ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED,
// ERR_CONNECTION_TIMED_OUT …), "cancelled by the app" (its own timeout or a retry), or
// "hanging until the window closed" (still pending when the app quit).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function parseNetLog(file, closedAtMs) {
  let text = readFileSync(file, 'utf8').trim();
  if (!text.endsWith('}')) text = text.replace(/,\s*$/, '') + ']}';
  const log = JSON.parse(text);
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const errors = Object.fromEntries(Object.entries(log.constants.netError).map(([k, v]) => [v, k]));
  const bySource = new Map();
  for (const e of log.events) {
    const id = e.source.id;
    if (!bySource.has(id)) bySource.set(id, []);
    bySource.get(id).push(e);
  }
  const requests = [];
  let first = Infinity;
  let last = 0;
  for (const e of log.events) {
    first = Math.min(first, Number(e.time));
    last = Math.max(last, Number(e.time));
  }
  // The close is the log's end, less the time the close itself took.
  const closedAt = last - (closedAtMs ?? 0);
  for (const [, events] of bySource) {
    const startJob = events.find((e) => types[e.type] === 'URL_REQUEST_START_JOB' && e.phase === 1);
    if (!startJob) continue;
    const url = startJob.params?.url ?? '';
    if (!/penmoss\.app/.test(url)) continue;
    const alive = events.filter((e) => types[e.type] === 'REQUEST_ALIVE');
    const ended = alive.some((e) => e.phase === 2);
    const err = events.map((e) => e.params?.net_error).find((n) => typeof n === 'number' && n !== 0);
    const endTime = Math.max(...events.map((e) => Number(e.time)));
    requests.push({
      url: url.replace(/(token|key)=[^&]+/g, '$1=…'),
      method: startJob.params?.method ?? 'GET',
      atMs: Math.round(Number(startJob.time) - first),
      outcome: !ended
        ? 'hanging at close'
        : events.some((e) => types[e.type] === 'CANCELLED')
          ? endTime >= closedAt - 1500
            ? 'hanging until the window closed'
            : 'cancelled by the app'
          : err
            ? (errors[err] ?? `net error ${err}`)
            : 'completed',
      ms: Math.round(endTime - Number(startJob.time)),
    });
  }
  return requests.sort((a, b) => a.atMs - b.atMs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node netlog.mjs <netlog.json>');
    process.exit(2);
  }
  const requests = parseNetLog(file, 0);
  console.log(`${requests.length} requests to penmoss.app hosts`);
  for (const q of requests) console.log(`+${q.atMs} ms ${q.method} ${q.url} → ${q.outcome} (${q.ms} ms)`);
}
