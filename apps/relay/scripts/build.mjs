#!/usr/bin/env node
/**
 * Builds and deploys the relay with its version in it (PEN-195, A1700).
 *
 *   node scripts/build.mjs deploy [wrangler args]  Ryan's relay: wrangler deploy --env penmoss.
 *   node scripts/build.mjs template <dir>          The template htxryan/penmoss-relay holds: the
 *                                                  bundled Worker and the files the Deploy to
 *                                                  Cloudflare button reads, in <dir>.
 *   node scripts/build.mjs check <dir>             A template, copied alone into an empty folder,
 *                                                  passes `wrangler deploy --dry-run` there.
 *
 * The version is the source commit and its date, with "+ changes" when the relay or a package
 * it bundles has uncommitted edits. The relay's pages show it (src/version.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(here, '../..');
const wrangler = join(here, 'node_modules/.bin/wrangler');
/** What the relay bundles from the monorepo: a change here changes the template. */
const SOURCES = [
  'apps/relay',
  'packages/core',
  'packages/git-notebook',
  'packages/model',
  'packages/ui',
];

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function version() {
  const [commit, date] = git('log', '-1', '--format=%h %cs').split(' ');
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const edited = git('status', '--porcelain', '--', ...SOURCES) !== '';
  return `${commit} (${day})${edited ? ' + changes' : ''}`;
}

function run(cmd, args, cwd) {
  const done = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const define = () => ['--define', `RELAY_VERSION:${JSON.stringify(version())}`];

/** The button reads these: what each setting is for, on the deploy form. */
const BINDINGS = {
  OWNER_GITHUB_LOGIN: {
    description:
      'Your GitHub login, such as `octocat`. Only this account can set the relay up, sign in to it and connect Claude.',
  },
  AGENT_LABEL: {
    description: 'The writer’s name for Claude’s edits in History. Leave it as `claude.ai`.',
  },
  ALLOWED_REDIRECT_HOSTS: {
    description:
      'Where a sign-in may be sent, comma-separated. Leave it as `claude.ai,claude.com` for Claude.',
  },
};

function readme(v) {
  return `# Penmoss Relay

Lets Claude read and write your [Penmoss](https://penmoss.app) notebooks: on claude.ai, in the desktop app and on your phone. It runs on your own Cloudflare account and reaches your notebooks' GitHub repositories through a GitHub App of your own. Penmoss never sees your notes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/htxryan/penmoss-relay)

1. Press **Deploy to Cloudflare**, and type your GitHub login as \`OWNER_GITHUB_LOGIN\`.
2. Open the relay's address, then **Set Up This Relay**: it makes its GitHub App on your account, and you install it on your notebooks' repositories.
3. Sign in, and add your notebooks on the **Notebooks** page.
4. In Claude, add a custom connector with the address the Notebooks page shows.

The whole guide: [Use Penmoss in Claude](https://penmoss.app/docs/agents/claude-ai/).

## Updating

Your copy of this repository is yours: it doesn't follow this one. To update, download [\`index.js\`](https://github.com/htxryan/penmoss-relay/raw/main/index.js) from here and upload it to your copy on GitHub (**Add file**, **Upload files**). Cloudflare deploys it. The relay's pages show which version you run.

This is version ${v}. It is built from [\`apps/relay\`](https://github.com/htxryan/penmoss/tree/main/apps/relay) in htxryan/penmoss, and every change here is made there: edits to this repository are overwritten.
`;
}

function template(out) {
  const config = parse(readFileSync(join(here, 'wrangler.jsonc'), 'utf8'));
  const v = version();
  const bundle = mkdtempSync(join(tmpdir(), 'penmoss-relay-'));
  try {
    run(wrangler, ['deploy', '--dry-run', '--outdir', bundle, ...define()], here);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(bundle, 'index.js'), join(out, 'index.js'));
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
  const generic = { ...config };
  delete generic.$schema;
  delete generic.env;
  const relayConfig = {
    ...generic,
    name: 'penmoss-relay',
    main: 'index.js',
    // Already bundled, with its version in it.
    no_bundle: true,
  };
  writeFileSync(
    join(out, 'wrangler.jsonc'),
    `// Penmoss Relay ${v}. Built from htxryan/penmoss (apps/relay/wrangler.jsonc); edit it there.\n${JSON.stringify(relayConfig, null, 2)}\n`,
  );
  const wranglerVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    .devDependencies.wrangler;
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(
      {
        name: 'penmoss-relay',
        private: true,
        license: 'MIT',
        description: 'Penmoss Relay: lets Claude read and write your Penmoss notebooks.',
        scripts: { deploy: 'wrangler deploy', dev: 'wrangler dev' },
        devDependencies: { wrangler: wranglerVersion },
        cloudflare: { bindings: BINDINGS },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(out, '.dev.vars.example'),
    '# Your GitHub login: only this account can set the relay up, sign in to it and connect Claude.\nOWNER_GITHUB_LOGIN=your-github-login\n',
  );
  writeFileSync(join(out, '.gitignore'), 'node_modules/\n.wrangler/\n.dev.vars\n');
  writeFileSync(join(out, 'README.md'), readme(v));
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
  console.log(`Penmoss Relay ${v}: template in ${out}`);
}

function check(dir) {
  const alone = mkdtempSync(join(tmpdir(), 'penmoss-relay-check-'));
  try {
    cpSync(resolve(dir), alone, { recursive: true });
    run(wrangler, ['deploy', '--dry-run', '--outdir', join(alone, '.dry-run')], alone);
  } finally {
    rmSync(alone, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'deploy') {
  run(wrangler, ['deploy', '--env', 'penmoss', ...define(), ...rest], here);
} else if (command === 'template' && rest[0]) {
  template(resolve(rest[0]));
} else if (command === 'check' && rest[0]) {
  check(rest[0]);
} else {
  console.error('Usage: node scripts/build.mjs deploy | template <dir> | check <dir>');
  process.exit(2);
}
