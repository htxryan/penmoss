#!/usr/bin/env node
// Port blocks (#260, F2): two checkouts can run their dev servers and test suites side by side.
// PENMOSS_PORT_BLOCK=n puts every fixed port at 20000 + 100·n + its offset below; block 0,
// the default, keeps today's ports, which CI's Mac runners and Ryan's own `task dev` use. The
// factory's slots use blocks 1 and 2 (tools/factory/factory.config.json).
//
//   node scripts/ports.mjs           every port for this block, as NAME=port lines
//   node scripts/ports.mjs vite      one port

/** Today's ports (block 0). */
export const BASE_PORTS = Object.freeze({
  /** Vite's dev server (the web suite's page). */
  vite: 5173,
  /** `vite preview` of a production build (CSP specs, performance budgets). */
  preview: 4173,
  /** `wrangler dev` for the relay Worker. */
  worker: 8787,
  /** The Mac suite's fake GitHub (apps/desktop/test/e2e/fake-github.ts). */
  fakeGithub: 8791,
  /** The Worker's inspector under `wrangler dev`. */
  inspector: 9229,
});

/**
 * Each port's place in a block: its last two digits, except vite preview's, which sits beside
 * vite's (4173 and 5173 share 73). Nothing lands on 41–45: cloudflared serves its metrics on
 * 20241–20245, which block 2 would hit.
 */
export const OFFSETS = Object.freeze({
  vite: 73,
  preview: 74,
  worker: 87,
  fakeGithub: 91,
  inspector: 29,
});

/** The highest block: its ports stay under 30000, clear of macOS's ephemeral range (49152+). */
export const MAX_BLOCK = 99;

/**
 * The block number from a PENMOSS_PORT_BLOCK value: 0 when unset or empty.
 * @param {string | undefined} value
 * @returns {number}
 */
export function parseBlock(value) {
  if (value === undefined || value.trim() === '') return 0;
  const block = Number(value);
  if (!Number.isInteger(block) || block < 0 || block > MAX_BLOCK) {
    throw new Error(
      `PENMOSS_PORT_BLOCK must be a whole number from 0 to ${MAX_BLOCK}, not "${value}"`,
    );
  }
  return block;
}

/**
 * Every port for a block.
 * @param {number} block
 * @returns {Readonly<Record<keyof typeof BASE_PORTS, number>>}
 */
export function portsFor(block) {
  parseBlock(String(block));
  if (block === 0) return BASE_PORTS;
  return /** @type {Record<keyof typeof BASE_PORTS, number>} */ (
    Object.freeze(
      Object.fromEntries(
        Object.entries(OFFSETS).map(([name, offset]) => [name, 20000 + 100 * block + offset]),
      ),
    )
  );
}

/**
 * The ports for the block in `env` (PENMOSS_PORT_BLOCK).
 * @param {Readonly<Record<string, string | undefined>>} [env]
 */
export function ports(env = process.env) {
  return portsFor(parseBlock(env['PENMOSS_PORT_BLOCK']));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = ports();
  const [name] = process.argv.slice(2);
  if (name === undefined) {
    for (const [key, port] of Object.entries(all)) console.log(`${key}=${port}`);
  } else if (Object.hasOwn(all, name)) {
    console.log(all[/** @type {keyof typeof all} */ (name)]);
  } else {
    console.error(`ports.mjs: no port named "${name}" (${Object.keys(all).join(', ')})`);
    process.exitCode = 2;
  }
}
