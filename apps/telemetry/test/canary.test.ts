/**
 * Canaries (PEN-137, AC14): batches whose events try to carry the canary notebook's strings
 * (test/fixtures/canary-notebook/canaries.json), as they are, in another case and URL-encoded,
 * in every field and prop, leave none of them in D1, and the answers don't echo them.
 */
import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import canaries from '../../../test/fixtures/canary-notebook/canaries.json';

const variants = (text: string) => [
  text,
  text.toUpperCase(),
  text.toLowerCase(),
  encodeURIComponent(text),
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
];

/** A valid event of each kind, the canary goes into one field of a copy. */
const BASE: Record<string, unknown> = {
  session: '0123456789abcdef',
  seq: 0,
  at: Date.now() - 60_000,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '15.6',
  sizeClass: 'expanded',
};

const KINDS: Record<string, { name: string; props: Record<string, unknown> }> = {
  app: { name: 'launch', props: { notebooks: '1', theme: 'paper' } },
  command: { name: 'app.palette', props: { source: 'key', keys: 'Mod+K', custom: false } },
  screen: { name: 'home', props: { from: 'note' } },
  dialog: { name: 'search', props: { action: 'open', open: '<1s' } },
  click: { name: 'privacy.share.on', props: { state: 'on' } },
  menu: { name: 'copy', props: { source: 'menubar' } },
  firstrun: { name: 'github', props: { result: 'failed', error: 'auth' } },
  feedback: { name: 'sent', props: { type: 'bug', priority: 2, screenshots: '1' } },
  sync: { name: 'pass', props: { result: 'ok', took: '<1s', changed: '2–4' } },
  cli: { name: 'search', props: { exit: 'OK', took: '<1s', tty: true } },
  tool: { name: 'search_notes', props: { agentClient: 'codex', result: 'ok', took: '<1s' } },
};

/** Every way an event could try to hold `text`. */
function attempts(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [kind, { name, props }] of Object.entries(KINDS)) {
    const base = { ...BASE, kind, name, props };
    for (const field of [...Object.keys(BASE), 'kind', 'name']) {
      events.push({ ...base, [field]: text });
    }
    events.push({ ...base, name: `${name}.${text}` });
    events.push({ ...base, title: text });
    events.push({ ...base, props: { ...props, [text]: true } });
    events.push({ ...base, props: { ...props, title: text } });
    for (const key of Object.keys(props)) {
      events.push({ ...base, props: { ...props, [key]: text } });
      events.push({ ...base, props: { ...props, [key]: [text] } });
    }
  }
  events.push({ ...BASE, kind: 'command', name: 'app.palette', props: { keys: `Mod+${text}` } });
  events.push({ ...BASE, kind: 'cli', name: 'search', props: { flags: [`--${text}`] } });
  return events;
}

it('no canary string reaches D1 from any field of any kind', async () => {
  const texts = canaries.strings.flatMap(variants);
  let seq = 0;
  for (const [index, text] of texts.entries()) {
    // Its own install per text, so the install limit never answers instead of the checks.
    const install = (index + 1).toString(16).padStart(32, '0');
    const tries = attempts(text);
    for (let start = 0; start < tries.length; start += 199) {
      // A valid event first in each batch: the batch is taken, the tries refused one by one.
      const control: Record<string, unknown> = {
        ...BASE,
        kind: 'click',
        name: 'privacy.share.on',
        props: { state: 'on' },
      };
      // A try that puts the canary in seq keeps it there.
      const events = [control, ...tries.slice(start, start + 199)].map((event) => ({
        ...event,
        seq: typeof event['seq'] === 'number' ? seq++ : event['seq'],
      }));
      const response = await exports.default.fetch('https://t.penmoss.test/v1/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${index}` },
        body: JSON.stringify({ v: 1, install, events }),
      });
      expect(response.status).toBe(202);
      const answer = await response.text();
      expect(answer).not.toMatch(/canary/i);
      expect(JSON.parse(answer)).toMatchObject({ accepted: 1, dropped: events.length - 1 });
    }
    // The envelope's install id can't carry it either.
    const envelope = await exports.default.fetch('https://t.penmoss.test/v1/batch', {
      method: 'POST',
      headers: { 'cf-connecting-ip': `192.0.2.${index}` },
      body: JSON.stringify({ v: 1, install: text, events: [] }),
    });
    expect(envelope.status).toBe(400);
  }
  const tables = ['events', 'daily_counts', 'daily_installs', 'catalogue', 'ingest_daily'];
  for (const table of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    const dump = JSON.stringify(results);
    expect(dump, table).not.toMatch(/canary/i);
    for (const text of texts) expect(dump.toLowerCase()).not.toContain(text.toLowerCase());
  }
  // The control events did get through, so the check looked at a table with rows in it.
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').all<{ n: number }>();
  expect(results[0]!.n).toBeGreaterThanOrEqual(texts.length);
});
