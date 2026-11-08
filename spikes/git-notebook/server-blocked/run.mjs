#!/usr/bin/env node
// G0 "server blocked" (#148): the Mac app's build (apps/desktop, `task desktop:build`) launched
// under xvfb with *.penmoss.app blocked, three ways a corporate network blocks a host:
//
//   drop      connections to it hang (pf `block drop`): Chromium maps the names to 192.0.2.1
//   refuse    connections are refused at once (pf `block return`): mapped to 127.0.0.1
//   nxdomain  the names do not resolve (a DNS block)
//
// Blocking is Chromium's --host-resolver-rules for this one process, so nothing about the
// worker's own networking changes. Every main-process request goes through Chromium's network
// stack (net.fetch, apps/desktop/src/main.ts), so the rules and the net log cover it as they
// cover the page. Each run records every request to a penmoss.app host from the net log: when
// it started, whether it failed (and how) or was still hanging when the window closed, and how
// long launch took to a usable window.
//
//   xvfb-run -a node spikes/git-notebook/server-blocked/run.mjs [--modes drop,refuse,nxdomain]
//     [--states signed-out,signed-in] [--observe 45] [--json out.json]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseNetLog } from './netlog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const DESKTOP = join(repo, 'apps', 'desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron } = require('@playwright/test');

const { values: opts } = parseArgs({
  options: {
    modes: { type: 'string', default: 'drop,refuse,nxdomain' },
    states: { type: 'string', default: 'signed-out,signed-in' },
    observe: { type: 'string', default: '45' },
    json: { type: 'string' },
    shots: { type: 'string' },
  },
});

const HOSTS = ['penmoss.app', '*.penmoss.app'];
const RULES = {
  drop: HOSTS.map((h) => `MAP ${h} 192.0.2.1`).join(', '),
  refuse: HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', '),
  nxdomain: HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', '),
};
const API = 'https://api.penmoss.app';

/** A device session as the Mac app stores it after sign-in (session-store.ts), with fake tokens. */
function fakeSession() {
  const token = (prefix) => `${prefix}_${'A'.repeat(43)}`;
  return {
    token: token('pmd'),
    id: 'tok_spike',
    expiresAt: 4102444800000,
    deviceId: 'dev_spike',
    apiOrigin: API,
    user: { id: 'usr_spike', email: 'spike@example.invalid', displayName: 'Spike' },
    workspace: { id: 'ws_spike', name: 'Personal' },
    scopes: ['read', 'write', 'admin'],
    issuedAt: Date.now(),
    page: { token: token('pmd'), id: 'tok_spike_page', scopes: ['read', 'write'] },
  };
}

async function launch(userData, mode, netlog) {
  return _electron.launch({
    args: [DESKTOP, `--host-resolver-rules=${RULES[mode]}`, ...(netlog ? [`--log-net-log=${netlog}`, '--net-log-capture-mode=Default'] : [])],
    env: {
      ...process.env,
      // No PENMOSS_API_ORIGIN / PENMOSS_APP_ORIGIN: the production origins, as a packaged app.
      PENMOSS_USER_DATA: userData,
      PENMOSS_TEST_BASIC_TEXT_STORAGE: '1',
    },
  });
}

/** Seeds the signed-in state: the token encrypted by the app's own safeStorage. */
async function seedSession(userData, mode) {
  const app = await launch(userData, mode, null);
  await app.firstWindow();
  const b64 = await app.evaluate(async ({ safeStorage }, json) => (await safeStorage.encryptStringAsync(json)).toString('base64'), JSON.stringify(fakeSession()));
  await app.close();
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ version: 1, sessions: { [API]: b64 }, previous: {} }));
}

async function runOne(mode, state) {
  const dir = mkdtempSync(join(tmpdir(), `pm-blocked-${mode}-${state}-`));
  const userData = join(dir, 'userData');
  mkdirSync(userData);
  if (state === 'signed-in') await seedSession(userData, mode);
  const netlog = join(dir, 'netlog.json');
  const t0 = performance.now();
  const app = await launch(userData, mode, netlog);
  const page = await app.firstWindow();
  const firstWindowMs = Math.round(performance.now() - t0);
  await page.waitForLoadState('domcontentloaded');
  const domMs = Math.round(performance.now() - t0);
  // Usable: the app shell (sidebar or the sign-in screen) has rendered something to click.
  let readyMs = null;
  try {
    await page.waitForFunction(() => document.querySelectorAll('button').length > 3, null, { timeout: 30_000 });
    readyMs = Math.round(performance.now() - t0);
  } catch {
    readyMs = null;
  }
  const console = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.push(`${m.type()}: ${m.text().slice(0, 200)}`);
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  // Can a note be made and typed into with the server unreachable? (The personal workspace's
  // local-first path; a git notebook would not use the server at all.)
  let newNote = 'not tried';
  try {
    const before = page.url();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Alt+N');
    await page.waitForFunction((b) => location.href !== b, before, { timeout: 5_000 });
    newNote = `opened ${new URL(page.url()).pathname.replace(/[0-9A-Z]{26}/, '<id>')}`;
  } catch (error) {
    newNote = `no new note: ${String(error.message).split('\n')[0].slice(0, 80)}`;
  }
  await page.waitForTimeout(Number(opts.observe) * 1000);
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300);
  if (opts.shots) {
    mkdirSync(opts.shots, { recursive: true });
    await page.screenshot({ path: join(opts.shots, `${mode}-${state}.png`) });
  }
  const closeStart = performance.now();
  await app.close();
  const closeMs = Math.round(performance.now() - closeStart);
  const requests = parseNetLog(netlog, closeMs);
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
  return { mode, state, firstWindowMs, domMs, readyMs, closeMs, newNote, requests, console: [...new Set(console)].slice(0, 20), pageErrors, text };
}

const results = [];
for (const state of opts.states.split(',')) {
  for (const mode of opts.modes.split(',')) {
    process.stdout.write(`${mode} / ${state} … `);
    const r = await runOne(mode, state);
    results.push(r);
    console.log(`window ${r.firstWindowMs} ms, usable ${r.readyMs ?? 'never'} ms, ${r.requests.length} requests, close ${r.closeMs} ms; ${r.newNote}`);
    for (const q of r.requests) console.log(`   +${q.atMs} ms ${q.method} ${q.url} → ${q.outcome} (${q.ms} ms)`);
    for (const c of r.console) console.log(`   ${c}`);
    console.log(`   page: ${r.text.slice(0, 160)}`);
  }
}
if (opts.json) writeFileSync(opts.json, JSON.stringify(results, null, 2));
