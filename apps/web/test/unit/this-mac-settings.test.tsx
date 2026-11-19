// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DesktopGitHubSignIn,
  DesktopGitHubToken,
  DesktopGitHubTokenStatus,
  DesktopUpdateState,
  PenmossDesktop,
} from '../../src/desktop/bridge';
import { GitHubSettings } from '../../src/feedback/GitHubSettings';
import { checkedLine, updateChip } from '../../src/updates/updates';

// PEN-146: This Mac's pages. GitHub (was Status) offers Sign In with GitHub first and the token
// behind Use a Token Instead…; Updates' card says the version's standing in a chip and when it
// last checked.

const NONE: DesktopGitHubTokenStatus = {
  saved: false,
  login: null,
  problem: null,
  keychain: true,
  signedIn: false,
};

describe('Settings → GitHub (PEN-146)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let status: DesktopGitHubTokenStatus;
  let removed: number;

  const token: DesktopGitHubToken = {
    status: () => Promise.resolve(status),
    save: () => Promise.resolve(null),
    remove: () => {
      removed += 1;
      status = NONE;
      return Promise.resolve({ ok: true, status });
    },
    onChange: () => () => undefined,
  };
  const signIn = (available: boolean): DesktopGitHubSignIn => ({
    status: () => Promise.resolve({ available, state: { state: 'idle' }, login: null }),
    start: () => Promise.resolve(null),
    cancel: () => Promise.resolve(),
    onChange: () => () => undefined,
  });
  const bridge = (available: boolean) => {
    (window as { penmossDesktop?: Partial<PenmossDesktop> }).penmossDesktop = {
      githubToken: token,
      git: { github: { signIn: signIn(available) } } as unknown as PenmossDesktop['git'],
    };
  };
  const shown = async () => {
    await act(async () => {
      root!.render(<GitHubSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    status = NONE;
    removed = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    delete (window as { penmossDesktop?: unknown }).penmossDesktop;
  });

  it('offers Sign In with GitHub first, and the token behind Use a Token Instead…', async () => {
    bridge(true);
    await shown();
    expect(host.querySelector('h1')?.textContent).toBe('GitHub');
    expect(byTestId('github-account')?.textContent).toContain('Not Signed In');
    expect(byTestId('github-signin-start')?.textContent).toBe('Sign In with GitHub');
    expect(byTestId('github-token-input')).toBeNull();
    act(() => byTestId('github-token-open')!.click());
    expect(byTestId('github-token-input')).not.toBeNull();
    expect(document.activeElement).toBe(byTestId('github-token-input'));
    // What the sign-in is for, each a row Search Settings can open.
    for (const id of ['github-account', 'github-token', 'adding-notebooks', 'send-feedback']) {
      expect(host.querySelector(`[data-setting="${id}"]`), id).not.toBeNull();
    }
  });

  it('shows the token field at once in a build without Penmoss’s GitHub app', async () => {
    bridge(false);
    await shown();
    expect(byTestId('github-signin-start')).toBeNull();
    expect(byTestId('github-token-open')).toBeNull();
    expect(byTestId('github-token-input')).not.toBeNull();
    // Not focused: nobody asked for it.
    expect(document.activeElement).not.toBe(byTestId('github-token-input'));
  });

  it('names the account, and Sign Out is the one way to remove it', async () => {
    status = { ...NONE, saved: true, login: 'htxryan', signedIn: true };
    bridge(true);
    await shown();
    expect(byTestId('github-account')?.textContent).toContain('htxryan');
    expect(byTestId('github-token-saved')?.textContent).toBe(
      'Signed In with GitHub · kept in this Mac’s Keychain',
    );
    // Another account beside it (A1617): Add Account, or a token.
    expect(byTestId('github-signin-start')?.textContent).toBe('Add Account');
    expect(byTestId('github-token-open')?.textContent).toBe('Use a Token Instead…');
    expect(byTestId('github-make-primary')).toBeNull();
    expect(byTestId('github-token-remove')?.textContent).toBe('Sign Out');
    await act(async () => {
      byTestId('github-token-remove')!.click();
      await Promise.resolve();
    });
    expect(removed).toBe(1);
    expect(byTestId('github-account')?.textContent).toContain('Not Signed In');
  });

  it('lists each account, with Use for Send Feedback and Sign Out for each (A1617)', async () => {
    const primaries: string[] = [];
    const signedOut: Array<string | null | undefined> = [];
    status = {
      ...NONE,
      saved: true,
      login: 'htxryan',
      signedIn: true,
      accounts: [
        { login: 'htxryan', primary: true, signedIn: true, problem: null },
        { login: 'ryan-work', primary: false, signedIn: true, problem: null },
      ],
    };
    const many: DesktopGitHubToken = {
      ...token,
      remove: (login) => {
        signedOut.push(login);
        return Promise.resolve({ ok: true, status });
      },
      makePrimary: (login) => {
        primaries.push(login);
        return Promise.resolve({ ok: true, status });
      },
    };
    (window as { penmossDesktop?: Partial<PenmossDesktop> }).penmossDesktop = {
      githubToken: many,
      git: { github: { signIn: signIn(true) } } as unknown as PenmossDesktop['git'],
    };
    await shown();
    expect(byTestId('github-account')?.textContent).toContain('htxryan');
    expect(byTestId('github-token-saved')?.textContent).toBe(
      'Send Feedback uses it · Signed In with GitHub · kept in this Mac’s Keychain',
    );
    expect(byTestId('github-account-ryan-work')?.textContent).toContain('ryan-work');
    expect(byTestId('github-signin-start')?.textContent).toBe('Add Account');
    await act(async () => {
      byTestId('github-make-primary')!.click();
      await Promise.resolve();
    });
    expect(primaries).toEqual(['ryan-work']);
    await act(async () => {
      byTestId('github-account-remove')!.click();
      await Promise.resolve();
    });
    expect(signedOut).toEqual(['ryan-work']);
  });

  it('is not there outside the Mac app', () => {
    act(() => root!.render(<GitHubSettings />));
    expect(host.innerHTML).toBe('');
  });
});

describe('Settings → Updates’ version card (PEN-146)', () => {
  const state = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
    supported: true,
    auto: false,
    channel: 'stable',
    current: '0.9.3',
    phase: 'current',
    version: null,
    percent: null,
    message: null,
    checkedAt: null,
    updatedFrom: null,
    ...patch,
  });

  it('says how this version stands in a chip', () => {
    expect(updateChip(state({}))).toBe('Up to Date');
    expect(updateChip(state({ phase: 'available', version: '0.9.4' }))).toBe('Update Available');
    expect(updateChip(state({ phase: 'downloading' }))).toBe('Downloading');
    expect(updateChip(state({ phase: 'error' }))).toBe('Couldn’t Check');
    expect(updateChip(state({ phase: 'idle' }))).toBeNull();
  });

  it('names the channel and when it last checked', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(checkedLine(state({}), now)).toBe('Stable · Not Checked Yet');
    expect(checkedLine(state({ checkedAt: now - 5 * 60_000 }), now)).toBe(
      'Stable · Checked 5 minutes ago',
    );
    expect(checkedLine(state({ channel: 'alpha', checkedAt: now }), now)).toBe(
      'Alpha · Checked just now',
    );
  });
});
