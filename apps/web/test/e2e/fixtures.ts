/**
 * The web suite's test (T59, D48, D49): every page runs as the Mac app's page does, with
 * `window.penmossDesktop` (support/fake-bridge.ts) whose git calls reach a real `GitNotebooks`
 * (support/git-host.ts) over system git and `file://` bare repositories. No server.
 *
 * By default each test starts with one git notebook already added (“Notes”, empty: the page
 * makes it on its first sync). `test.use({ seed: … })` seeds folders and notes first, pushed by
 * another writer, and `seed: null` starts with no notebook at all (the first run).
 */
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import {
  GIT_BINDING,
  GIT_CHANGED,
  GITHUB_TOKEN_CHANGED,
  installFakeBridge,
  SIGN_IN_CHANGED,
  MEANING_CHANGED,
  UPDATES_CHANGED,
} from './support/fake-bridge';
import {
  FEEDBACK_CALLS,
  GitHost,
  GITHUB_TOKEN,
  HOST_CALLS,
  UPDATE_CALLS,
  CLI_CALLS,
  GITHUB_CALLS,
  MEANING_CALLS,
  type HostCall,
  type SeedNote,
  type SeededNotebook,
} from './support/git-host';
import { webPreviewPort } from '../../../../packages/core/test/support/checkout-ports';

// Everything else of Playwright's, so a spec imports from here only.
export * from '@playwright/test';
export { expect };
export type { SeedNote, SeededNotebook };
export { GitHost, GITHUB_TOKEN };

/** What a test starts with: a notebook (with folders and notes), or none (null). */
export interface Seed {
  readonly name?: string;
  readonly folders?: readonly string[];
  readonly notes?: readonly SeedNote[];
  readonly images?: readonly Uint8Array[];
}

/** The production build (`vite preview`, playwright.config.ts): the CSP specs and the budgets. */
export const PREVIEW = `http://localhost:${webPreviewPort()}`;

const CALLS: ReadonlySet<string> = new Set([
  ...HOST_CALLS,
  ...FEEDBACK_CALLS,
  ...UPDATE_CALLS,
  ...CLI_CALLS,
  ...GITHUB_CALLS,
  ...MEANING_CALLS,
]);

/** The bytes codec of the binding, Node's side (the page's is in fake-bridge.ts). */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const bytes = (value as { __bytes?: unknown }).__bytes;
    if (typeof bytes === 'string') return new Uint8Array(Buffer.from(bytes, 'base64'));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

/**
 * Makes every page of `context` (tabs, popups, note windows) a window of the Mac app whose main
 * process is `host`. Call before the context opens a page.
 */
export async function connectContext(
  context: BrowserContext,
  host: GitHost,
  options: { readonly meaning?: boolean; readonly macWindow?: boolean } = {},
): Promise<void> {
  await context.exposeBinding(GIT_BINDING, async (_source, method: unknown, args: unknown) => {
    if (typeof method !== 'string' || !CALLS.has(method)) {
      throw new Error(`No such git call: ${String(method)}`);
    }
    const list = Array.isArray(args) ? (decode(args) as unknown[]) : [];
    return encode(await host.call(method as HostCall, list));
  });
  const meaning = options.meaning ? host.enableMeaning() : null;
  await context.addInitScript(installFakeBridge, {
    platform: process.platform,
    meaning: meaning !== null,
    macWindow: options.macWindow === true,
  });
  const tell = (hook: string) => {
    for (const page of context.pages()) {
      void page
        .evaluate((name) => (window as unknown as Record<string, () => void>)[name]?.(), hook)
        .catch(() => undefined);
    }
  };
  host.onChange(() => tell(GIT_CHANGED));
  host.onTokenChange(() => tell(GITHUB_TOKEN_CHANGED));
  const tellWith = (hook: string, state: unknown) => {
    for (const page of context.pages()) {
      void page
        .evaluate(
          ({ name, value }) =>
            (window as unknown as Record<string, (state: unknown) => void>)[name]?.(value),
          { name: hook, value: state },
        )
        .catch(() => undefined);
    }
  };
  host.onUpdateChange((state) => tellWith(UPDATES_CHANGED, state));
  host.onSignInChange((state) => tellWith(SIGN_IN_CHANGED, state));
  meaning?.onChange((status) => tellWith(MEANING_CHANGED, status));
}

/**
 * A new browser context (its own IndexedDB and storage) whose pages are windows of the Mac app
 * whose main process is `host`: the test's own host for a fresh profile on this Mac (the
 * production build on another origin, a phone-sized window), or another Mac's (`anotherMac`).
 */
export async function macContext(
  browser: Browser,
  host: GitHost,
  options?: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await connectContext(context, host);
  return context;
}

/**
 * Another Mac on the same remotes (a second browser profile): its own main process and data,
 * its own IndexedDB. Adds `remote` there when given. Close the context when done.
 */
export async function anotherMac(
  browser: Browser,
  options: {
    readonly remote?: string;
    readonly name?: string;
    readonly context?: BrowserContextOptions;
  } = {},
): Promise<{ readonly host: GitHost; readonly context: BrowserContext; readonly page: Page }> {
  const host = new GitHost();
  const context = await macContext(browser, host, options.context);
  context.on('close', () => void host.close());
  if (options.remote) await host.add(options.remote, options.name ?? 'Notes');
  const page = await context.newPage();
  return { host, context, page };
}

/** The stand-in Mac of each test's own context. */
const hosts = new WeakMap<BrowserContext, GitHost>();

export const test = base.extend<{
  /** What the test starts with; null: no notebook (the first run). */
  seed: Seed | null;
  /** The stand-in Mac's main process. */
  host: GitHost;
  /** The stand-in Mac has search by meaning (T77): its service, with a concept embedder. */
  meaning: boolean;
  /** The windows have the Mac's `macWindow`: Keep on Top's pin and the compact title bar. */
  macWindow: boolean;
  /** The notebook the test starts in, or null with `seed: null`. */
  notebook: SeededNotebook | null;
}>({
  seed: [{}, { option: true }],
  meaning: [false, { option: true }],
  macWindow: [false, { option: true }],
  // The test's context is a window set of one stand-in Mac: its main process comes with it.
  context: async ({ context, meaning, macWindow }, use) => {
    const host = new GitHost();
    hosts.set(context, host);
    await connectContext(context, host, { meaning, macWindow });
    await use(context);
    await context.close();
    await host.meaning?.stop();
    await host.close();
  },
  host: async ({ context }, use) => {
    await use(hosts.get(context)!);
  },
  notebook: [
    async ({ host, seed }, use) => {
      await use(seed ? await host.seed(seed) : null);
    },
    { auto: true },
  ],
});

/** The seeded notebook (a test that ran with `seed: null` has none). */
export function seeded(notebook: SeededNotebook | null): SeededNotebook {
  if (!notebook) throw new Error('This test has no notebook.');
  return notebook;
}
