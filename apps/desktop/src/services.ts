/**
 * The main process's services (T50, T54, T57, T64, T76, T81, T82): git notebooks, the owner
 * check, Auto-Update and its release notes, search by meaning, the person's GitHub token, GitHub
 * browsing and sign-in, and agents on this Mac. Each is made once, as the app starts; main.ts
 * and the IPC handlers (ipc/*.ts) use them. Each tells every window of its changes itself.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, net, safeStorage, shell, systemPreferences, utilityProcess } from 'electron';
import { nodeNotebooks } from '@penmoss/cli/node';
import { AdminCheck, runHelper } from './admin-check';
import { config, dataFile, log, mac } from './app-state';
import { broadcast } from './broadcast';
import { EmbeddingService } from './embedding-service';
import { GitNotebooks } from './git-notebooks';
import { GitProcessFile } from './git-processes';
import { GitHubBrowseHost } from './github-browse-host';
import { DeviceSignIn } from './github-device-sign-in';
import { chromiumInit, GitHubToken } from './github-token';
import { cliCommand, keptLoginPath, LocalAgents, loginShellPath } from './local-agents';
import { ReleaseNotes } from './release-notes';
import { encryptionUsable } from './sealing';
import { sshHostResolver } from './ssh-host';
import { Updates, updateMode } from './updater';

/**
 * Touch ID or the Mac's password before an owner check on a git notebook (removing it, Delete
 * for good; T41, D34, A504, A855), never a plain confirmation: Touch
 * ID itself where the Mac has it, else the signed helper in the app, which only answers with its
 * exit code.
 */
export const adminCheck = new AdminCheck({
  helper: config.authHelper,
  run: runHelper,
  // Main's own checks ask Touch ID itself where the Mac has it (T50, A855); the suite's stand-in
  // answers them all.
  touchId:
    mac && !config.testAuthHelper
      ? {
          can: () => systemPreferences.canPromptTouchID(),
          prompt: (reason) => systemPreferences.promptTouchID(reason),
        }
      : null,
});
// --- git notebooks (T50 G3, G5; A853–A857) ---

/** Whether safeStorage really encrypts here (sealing.ts). */
const sealable = async () =>
  encryptionUsable({
    platform: process.platform,
    available: await safeStorage.isAsyncEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'unknown',
    allowBasicText: config.allowBasicTextStorage,
  });
export const gitNotebooks = new GitNotebooks({
  dir: app.getPath('userData'),
  seal: async (plain) =>
    (await sealable()) ? (await safeStorage.encryptStringAsync(plain)).toString('base64') : null,
  unseal: async (sealed) => {
    if (!(await sealable())) return null;
    return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result;
  },
  ownerCheck: (words) => adminCheck.confirmOwn(words),
  platform: process.platform,
  // An SSH alias's real host, for Open on GitHub (A1565).
  resolveSshHost: sshHostResolver(),
  ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}),
  log,
  onChange: () => {
    broadcast('gitChanged');
    // Every agent on this Mac reaches every notebook in the app (D52).
    void localAgents.ensureAll();
  },
});
/**
 * Release notes for Settings → Updates (PEN-108): fetched from beside the channel's update feed
 * on every check and when Settings asks, at most once an hour, and kept in userData.
 */
export const releaseNotes = new ReleaseNotes({
  mode: () => updateMode(app.isPackaged, process.resourcesPath),
  dir: app.getPath('userData'),
  log,
  onChange: (file) => broadcast('updatesNotesChanged', file),
});
/** Auto-Update from GitHub Releases, Stable or Alpha (T64 item 2, A1112, A1196): no token. */
export const updates = new Updates({
  mode: () => updateMode(app.isPackaged, process.resourcesPath),
  version: () => config.testVersion ?? app.getVersion(),
  dir: app.getPath('userData'),
  log,
  onChange: (state) => {
    if (state.phase === 'checking') void releaseNotes.refresh(state.channel);
    broadcast('updatesChanged', state);
  },
});
/** The CLI's `~/.penmoss` (A992): agents' clones, and search by meaning's model and vectors. */
const penmossHome = process.env['PENMOSS_HOME'] || join(homedir(), '.penmoss');
/**
 * Search by meaning (T76, A1152, A1157, A1158): the embedding service in a utilityProcess, which
 * downloads the model unless the setting is off, holds the indexing lease and answers the
 * page's queries. Main relays the page's named calls to it and restarts it after a crash.
 */
export const meaning =
  config.testMeaning === 'off'
    ? null
    : new EmbeddingService({
        writeSetting: async (enabled) => {
          await mkdir(penmossHome, { recursive: true });
          await writeFile(
            join(penmossHome, 'meaning.json'),
            `${JSON.stringify({ enabled }, null, 2)}\n`,
          );
        },
        fork: () => {
          const child = utilityProcess.fork(join(__dirname, 'embed-utility.cjs'), [], {
            serviceName: 'Penmoss Semantic Search',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PENMOSS_HOME: penmossHome,
              ...(config.testMeaning === 'no-download' ? { PENMOSS_MEANING_DOWNLOAD: '0' } : {}),
            },
          });
          const forward = (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) log(line);
          };
          child.stdout?.on('data', forward);
          child.stderr?.on('data', forward);
          return child;
        },
        onStatus: (status) => broadcast('meaningChanged', status),
        log,
      });
/**
 * The person's own GitHub token (T57, A1010–A1012): Send feedback is filed with it from here.
 * Sealed like the git tokens. Updates no longer need it (A1112).
 */
export const githubToken = new GitHubToken({
  dir: app.getPath('userData'),
  seal: async (plain) =>
    (await sealable()) ? (await safeStorage.encryptStringAsync(plain)).toString('base64') : null,
  unseal: async (sealed) => {
    if (!(await sealable())) return null;
    return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result;
  },
  fetch: (url, init) => net.fetch(url instanceof Request ? url : String(url), chromiumInit(init)),
  api: config.githubApi,
  log,
  onChange: () => {
    broadcast('githubTokenChanged');
  },
});
/**
 * Add a Git Notebook's GitHub browsing (T81, A1163–A1165): git's own credential, asked for on
 * each call, sent only to the GitHub API base; the page sees repositories and folders.
 */
export const githubBrowse = new GitHubBrowseHost({
  fetch: (url, init) => net.fetch(url, chromiumInit(init)),
  api: config.githubApi,
  gitEnv: config.gitEnv,
  // Penmoss's own sign-in when git has none (T82, A1171).
  penmossToken: () => githubToken.token(),
  onPenmossRefused: () => githubToken.refused(),
});
/**
 * Sign in with GitHub (T82, A1170): the device flow for Penmoss's OAuth app. The token goes to
 * the GitHub Token store; the page sees the code to enter and the outcome.
 */
export const githubSignIn = new DeviceSignIn({
  fetch: (url, init) => net.fetch(url, init),
  clientId: config.githubClientId,
  web: config.githubWeb,
  // The suite's fake GitHub (unpackaged builds only) opens no browser: it is only logged.
  openExternal: (url) =>
    config.githubWeb ? Promise.resolve(log(`sign-in page ${url}`)) : shell.openExternal(url),
  keep: async (token) => {
    const login = await githubBrowse.loginOf(token);
    return { kept: await githubToken.saveSignedIn(token, login), login };
  },
  onChange: (state) => broadcast('githubSignInChanged', state),
  log,
});
/**
 * Agents on this Mac with no account (T54, A992–A994): the `penmoss` command, which is this binary
 * with `--penmoss-cli`, and agents' clones of a git notebook in the CLI's own `~/.penmoss`.
 */
/** The terminal's PATH, asked of the login shell as the app starts and kept (A1124). */
export const loginPath = keptLoginPath(() => loginShellPath(process.env['SHELL'] || '/bin/zsh'));
/**
 * The command every agent and the `penmoss` script are given: a packaged Mac app's CLI bundle
 * (PEN-121), so no MCP server checks in with LaunchServices as Penmoss itself.
 */
const cli = cliCommand({
  exe: app.getPath('exe'),
  appPath: app.getAppPath(),
  packaged: app.isPackaged,
  platform: process.platform,
});
export const localAgents = new LocalAgents({
  cli: cli.cli,
  oldCli: cli.old,
  home: config.testHome ?? homedir(),
  shell: process.env['SHELL'] || '/bin/zsh',
  loginPath: loginPath.get,
  notebooks: () =>
    nodeNotebooks({
      home: penmossHome,
      env: process.env,
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
      ...(config.gitEnv ? { gitEnv: config.gitEnv } : {}),
      terminal: () => false,
    }),
  notebook: (localId) => gitNotebooks.forAgent(localId),
  all: () => gitNotebooks.forAgents(),
  ownerCheck: (words) => adminCheck.confirmOwn(words),
  log,
});
/** Every git a git notebook runs, so a crashed run's leftovers die at the next launch (A853). */
export const gitProcesses = new GitProcessFile(dataFile('git-processes.json'), { log });
