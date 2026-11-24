/**
 * The local test servers' ports for this checkout (A1177), for the web and Electron Playwright
 * configs. Each worktree gets its own, so two sessions' suites never collide on one port (the
 * Electron suite's fake GitHub was fixed at :8791 and refused to start beside another worktree's
 * run). The ports come from a hash of the checkout's path, in 20000–59999, so the same checkout
 * always gets the same ones.
 *
 * `PENMOSS_PORT_BLOCK=n` (the factory's slots, ports.mjs) uses that block's ports instead of the
 * hash. An environment variable still wins (CI's `mac-runner.sh pick-ports` sets the e2e ones):
 * `PENMOSS_E2E_PORT`, `PENMOSS_E2E_PREVIEW_PORT`, `PENMOSS_DESKTOP_FAKE_GITHUB_PORT`,
 * `PENMOSS_SITE_PORT`. Each is set here when missing, so specs and fixtures read the same number
 * in Playwright's workers. The site's screenshots take the base + 5 (site/scripts).
 *
 * Node-only.
 */
import { fileURLToPath } from 'node:url';
import { parseBlock, portsFor } from './ports.mjs';

/** The repository root: this file is scripts/. */
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * FNV-1a, 32 bits.
 * @param {string} text
 */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The first of this checkout's ten ports.
 * @param {string} [path]
 * @returns {number}
 */
export function checkoutPortBase(path = root) {
  return 20000 + (fnv1a(path) % 4000) * 10;
}

/**
 * @param {string} name
 * @param {number} offset
 * @param {import('./ports.mjs').PortName} inBlock
 */
function pick(name, offset, inBlock) {
  const set = Number(process.env[name]);
  const block = parseBlock(process.env['PENMOSS_PORT_BLOCK']);
  const port =
    Number.isInteger(set) && set > 0
      ? set
      : block > 0
        ? portsFor(block)[inBlock]
        : checkoutPortBase() + offset;
  process.env[name] = String(port);
  return port;
}

/** Vite's dev server for the web suite. */
export function webE2ePort() {
  return pick('PENMOSS_E2E_PORT', 0, 'vite');
}

/** `vite preview` for the web suite's CSP specs and budgets. */
export function webPreviewPort() {
  return pick('PENMOSS_E2E_PREVIEW_PORT', 1, 'preview');
}

/** The Electron suite's fake GitHub (Send feedback). */
export function desktopFakeGitHubPort() {
  return pick('PENMOSS_DESKTOP_FAKE_GITHUB_PORT', 2, 'fakeGithub');
}

/** penmoss.app under `wrangler dev` for the site's suite (site/playwright.config.ts). */
export function sitePort() {
  return pick('PENMOSS_SITE_PORT', 3, 'site');
}
