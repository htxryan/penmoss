/// <reference types="node" />
/**
 * The local test servers' ports for this checkout (A1177), for the web and Electron Playwright
 * configs. Each worktree gets its own, so two sessions' suites never collide on one port (the
 * Electron suite's fake GitHub was fixed at :8791 and refused to start beside another worktree's
 * run). The ports come from a hash of the checkout's path, in 20000–59999, so the same checkout
 * always gets the same ones.
 *
 * `PENMOSS_PORT_BLOCK=n` (the factory's slots, scripts/ports.mjs) uses that block's ports instead
 * of the hash. An environment variable still wins (CI's `mac-runner.sh pick-ports` sets the e2e ones):
 * `PENMOSS_E2E_PORT`, `PENMOSS_E2E_PREVIEW_PORT`, `PENMOSS_DESKTOP_FAKE_GITHUB_PORT`. Each is set
 * here when missing, so specs and fixtures read the same number in Playwright's workers.
 *
 * Node-only.
 */
import { fileURLToPath } from 'node:url';
import { parseBlock, portsFor, type PortName } from '../../../../scripts/ports.mjs';

/** The repository root: this file is packages/core/test/support/. */
const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** FNV-1a, 32 bits. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The first of this checkout's ten ports. */
export function checkoutPortBase(path: string = root): number {
  return 20000 + (fnv1a(path) % 4000) * 10;
}

function pick(name: string, offset: number, inBlock: PortName): number {
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
export function webE2ePort(): number {
  return pick('PENMOSS_E2E_PORT', 0, 'vite');
}

/** `vite preview` for the web suite's CSP specs and budgets. */
export function webPreviewPort(): number {
  return pick('PENMOSS_E2E_PREVIEW_PORT', 1, 'preview');
}

/** The Electron suite's fake GitHub (Send feedback). */
export function desktopFakeGitHubPort(): number {
  return pick('PENMOSS_DESKTOP_FAKE_GITHUB_PORT', 2, 'fakeGithub');
}
