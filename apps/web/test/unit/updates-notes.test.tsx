// @vitest-environment happy-dom
/**
 * Settings → Updates' release notes (PEN-108): the offered update's, this version's and earlier
 * versions' (collapsed), each grouped by kind under headings; a link to GitHub without a file.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DesktopReleaseNotes,
  DesktopUpdateState,
  PenmossDesktop,
} from '../../src/desktop/bridge';
import { ToastStack } from '../../src/toasts/ToastStack';
import { useUpdateNotice } from '../../src/updates/notice';
import {
  SidebarUpdateNotice,
  UpdateNotice,
  UpdatesSettings,
} from '../../src/updates/UpdatesSettings';

/** The toast, as a narrow window shows it (its sidebar a drawer, PEN-135). */
function ToastNotice() {
  return <UpdateNotice notice={useUpdateNotice()} />;
}

/** The notice in the sidebar's bottom panel, or on the rail (PEN-135 item 10). */
function SidebarNotice({ rail = false }: { readonly rail?: boolean }) {
  return <SidebarUpdateNotice notice={useUpdateNotice()} rail={rail} />;
}

const FILE: DesktopReleaseNotes = {
  schema: 1,
  generated: '2026-11-20T00:00:00Z',
  releases: [
    { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
    { version: '0.2.1', tag: 'v0.2.1', build: 1180, date: '2026-11-20' },
  ],
  notes: [
    { build: 1165, pr: 165, kind: 'new', platform: null, text: 'Before 0.2.0.' },
    { build: 1174, pr: 174, kind: 'new', platform: null, text: 'Release notes in the app.' },
    { build: 1176, pr: 176, kind: 'fixed', platform: 'android', text: 'Android only.' },
    { build: 1178, pr: 178, kind: 'fixed', platform: 'mac', text: 'The window keeps its size.' },
  ],
};

const state = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  supported: true,
  auto: false,
  channel: 'stable',
  current: '0.2.0',
  phase: 'current',
  version: null,
  percent: null,
  message: null,
  checkedAt: null,
  ...patch,
});

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
});

let acknowledged = 0;

async function show(
  update: DesktopUpdateState,
  file: DesktopReleaseNotes | null,
  view: ReactElement = <UpdatesSettings />,
) {
  acknowledged = 0;
  const updates = {
    acknowledge: () => {
      acknowledged += 1;
      return Promise.resolve({ ...update, updatedFrom: null });
    },
    state: () => Promise.resolve(update),
    check: () => Promise.resolve(update),
    setAuto: () => Promise.resolve(update),
    setChannel: () => Promise.resolve(update),
    install: () => Promise.resolve(update),
    onChange: () => () => undefined,
    notes: () => Promise.resolve(file),
    onNotes: () => () => undefined,
  };
  Object.assign(window, { penmossDesktop: { updates } as unknown as PenmossDesktop });
  act(() => {
    root = createRoot(host);
    root.render(view);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const block = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const headings = (el: Element | null) =>
  [...(el?.querySelectorAll('h3, h4') ?? [])].map((h) => h.textContent);
const items = (el: Element | null) =>
  [...(el?.querySelectorAll('li') ?? [])].map((li) => li.textContent);

describe('Settings → Updates: release notes', () => {
  it("shows the offered update's notes, this version's, and earlier versions collapsed", async () => {
    await show(state({ current: '0.2.1', phase: 'current' }), FILE);
    expect(block('release-notes-offered')).toBeNull();
    expect(headings(block('release-notes-current'))).toEqual(['In this version', 'New', 'Fixed']);
    expect(items(block('release-notes-current'))).toEqual([
      'Release notes in the app.',
      'The window keeps its size.',
    ]);
    const earlier = block('release-notes-earlier') as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector('summary')?.textContent).toBe('Earlier versions');
    expect(headings(earlier)).toEqual(['0.2.0', 'New']);
  });

  it('shows what an offered update brings above this version', async () => {
    await show(state({ current: '0.2.0', phase: 'available', version: '0.2.1' }), FILE);
    const offered = block('release-notes-offered');
    expect(headings(offered)).toEqual(["What's new in 0.2.1", 'New', 'Fixed']);
    expect(items(offered)).not.toContain('Android only.');
    expect(items(block('release-notes-current'))).toEqual(['Before 0.2.0.']);
    expect(offered?.compareDocumentPosition(block('release-notes-current')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('names each build on Alpha', async () => {
    await show(state({ current: '0.2.1-alpha.1178', channel: 'alpha' }), FILE);
    expect(headings(block('release-notes-current'))[0]).toBe('In this version (since 0.2.0)');
    expect(items(block('release-notes-current'))).toContain(
      'The window keeps its size. (build 1178)',
    );
  });

  it('links to GitHub until there is a file', async () => {
    await show(state({}), null);
    const missing = block('release-notes-missing');
    expect(missing?.textContent).toMatch(/Release notes show once Penmoss can reach GitHub/);
    expect(missing?.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/htxryan/penmoss/releases',
    );
  });
});

describe('the notice after an update (PEN-110)', () => {
  it('says so once, with What’s New, which opens This version and is remembered', async () => {
    await show(
      state({ current: '0.2.1', updatedFrom: '0.2.0' }),
      FILE,
      <>
        {/* The notice is a toast: it shows in the window's stack (A1306). */}
        <ToastStack />
        <ToastNotice />
      </>,
    );
    const notice = block('updated-notice');
    expect(notice?.textContent).toContain('Updated to 0.2.1.');
    act(() => (block('updated-whats-new') as HTMLButtonElement).click());
    expect(acknowledged).toBe(1);
    expect(window.location.pathname + window.location.search).toBe('/settings/updates?whats-new');
    expect(block('updated-notice')).toBeNull();
  });

  it('dismissing it is remembered too', async () => {
    await show(
      state({ current: '0.2.1', updatedFrom: '0.2.0' }),
      FILE,
      <>
        {/* The notice is a toast: it shows in the window's stack (A1306). */}
        <ToastStack />
        <ToastNotice />
      </>,
    );
    act(() => (block('updated-dismiss') as HTMLButtonElement).click());
    expect(acknowledged).toBe(1);
    expect(block('updated-notice')).toBeNull();
  });

  it('says nothing without an update, or when the new version has no notes', async () => {
    await show(
      state({ current: '0.2.1', updatedFrom: null }),
      FILE,
      <>
        {/* The notice is a toast: it shows in the window's stack (A1306). */}
        <ToastStack />
        <ToastNotice />
      </>,
    );
    expect(block('updated-notice')).toBeNull();
    act(() => root?.unmount());
    root = null;
    await show(
      state({ current: '0.2.1', updatedFrom: '0.2.0' }),
      null,
      <>
        {/* The notice is a toast: it shows in the window's stack (A1306). */}
        <ToastStack />
        <ToastNotice />
      </>,
    );
    expect(block('updated-notice')).toBeNull();
  });
});

describe('the notice in the sidebar (PEN-135 item 10)', () => {
  it('is one line in the bottom panel, with What’s New and Dismiss', async () => {
    await show(state({ current: '0.2.1', updatedFrom: '0.2.0' }), FILE, <SidebarNotice />);
    const notice = block('updated-notice');
    expect(notice?.className).toBe('sb-update');
    expect(notice?.textContent).toContain('Updated to 0.2.1.');
    expect(notice?.closest('.toast')).toBeNull();
    act(() => (block('updated-dismiss') as HTMLButtonElement).click());
    expect(acknowledged).toBe(1);
    expect(block('updated-notice')).toBeNull();
  });

  it('is an icon with a dot on the rail, which opens What’s New', async () => {
    await show(state({ current: '0.2.1', updatedFrom: '0.2.0' }), FILE, <SidebarNotice rail />);
    const icon = block('updated-notice') as HTMLButtonElement;
    expect(icon.tagName).toBe('BUTTON');
    expect(icon.getAttribute('aria-label')).toBe("Updated to 0.2.1: What's New");
    expect(icon.querySelector('.sb-update-badge')).not.toBeNull();
    act(() => icon.click());
    expect(acknowledged).toBe(1);
    expect(window.location.pathname + window.location.search).toBe('/settings/updates?whats-new');
    expect(block('updated-notice')).toBeNull();
  });

  it('offers a build with Install and Restart; on the rail it leads to Settings → Updates', async () => {
    const offered = state({ current: '0.2.0', phase: 'available', version: '0.2.1' });
    await show(offered, FILE, <SidebarNotice />);
    expect(block('update-notice')?.textContent).toContain('Version 0.2.1 is available.');
    expect(block('update-install')?.textContent).toBe('Install and Restart');
    act(() => root?.unmount());
    root = null;
    await show(offered, FILE, <SidebarNotice rail />);
    const icon = block('update-notice') as HTMLButtonElement;
    expect(icon.getAttribute('aria-label')).toBe('Version 0.2.1 is available: Settings → Updates');
    act(() => icon.click());
    expect(window.location.pathname).toBe('/settings/updates');
  });
});
