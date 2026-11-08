/**
 * T28 acceptance: "custom themes sync across devices". Two Macs share a git notebook, whose
 * folders-and-settings document they merge (D49: the git engine carries it, A827; here each
 * update is handed straight across); a theme duplicated, edited and chosen on one is chosen and
 * identical on the other.
 */
import { setSetting } from '@penmoss/sync-client/workspace';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import {
  CUSTOM_THEME_PREFIX,
  deleteCustomTheme,
  duplicateAndChoose,
  NORD,
  resolveThemeSettings,
  saveCustomTheme,
  setThemeMode,
  SLATE,
} from '@penmoss/ui/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_DEVICE_SETTINGS, type Workspace } from '../../src/workspace/service';
import { testWorkspace } from './support/local-sources';
import { memoryNotes } from './support/memory-notes';

const toStop: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const item of toStop.splice(0)) item.stop();
});

/** What came from the other Mac (never handed back). */
const MERGED = Symbol('merged');

function device(): Workspace {
  const workspace = testWorkspace(memoryNotes());
  toStop.push(workspace);
  return workspace;
}

/** Hands each Mac's changes to the other, as their notebook's merges would. */
function link(a: Workspace, b: Workspace): void {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    from.replica.onUpdate((update, origin) => {
      if (origin !== MERGED) to.replica.applyUpdate(update, MERGED);
    });
  }
}

async function twoDevices() {
  const mac = device();
  const web = device();
  await Promise.all([mac.start(), web.start()]);
  link(mac, web);
  // What each had before the link.
  web.replica.applyUpdate(mac.replica.encodeStateAsUpdate(), MERGED);
  mac.replica.applyUpdate(web.replica.encodeStateAsUpdate(), MERGED);
  return { mac, web };
}

describe('custom themes sync across devices (T28)', () => {
  it('a theme duplicated, edited and chosen on one device is chosen on the other', async () => {
    const { mac, web } = await twoDevices();
    const copy = duplicateAndChoose(mac, NORD);
    const edited = { ...copy, name: 'Fjord', light: { ...copy.light, accent: '#205080' } };
    saveCustomTheme(mac, edited);
    setThemeMode(mac, 'light');

    await vi.waitFor(() => {
      const resolved = resolveThemeSettings(web.settings());
      expect(resolved.theme).toEqual(edited);
      expect(resolved.mode).toBe('light');
    });
    expect(resolveThemeSettings(web.settings()).custom.map((theme) => theme.name)).toEqual([
      'Fjord',
    ]);
  });

  it('merges edits to different themes made at the same time, and deletions', async () => {
    const { mac, web } = await twoDevices();
    const fromMac = duplicateAndChoose(mac, NORD);
    const fromWeb = duplicateAndChoose(web, SLATE);
    await vi.waitFor(() => {
      expect(resolveThemeSettings(mac.settings()).custom).toHaveLength(2);
      expect(resolveThemeSettings(web.settings()).custom).toHaveLength(2);
    });
    saveCustomTheme(mac, { ...fromMac, name: 'Mac edit' });
    saveCustomTheme(web, { ...fromWeb, name: 'Web edit' });
    await vi.waitFor(() =>
      expect(resolveThemeSettings(web.settings()).custom.map((theme) => theme.name)).toEqual([
        'Mac edit',
        'Web edit',
      ]),
    );
    deleteCustomTheme(web, { ...fromWeb, name: 'Web edit' });
    await vi.waitFor(() =>
      expect(resolveThemeSettings(mac.settings()).custom.map((theme) => theme.name)).toEqual([
        'Mac edit',
      ]),
    );
  });

  it('merges two devices’ edits to one theme: an edit saved after the other arrived keeps both', async () => {
    const { mac, web } = await twoDevices();
    const copy = duplicateAndChoose(mac, NORD);
    await vi.waitFor(() => expect(resolveThemeSettings(web.settings()).theme.id).toBe(copy.id));
    // The Mac starts editing the background; meanwhile the web changes the accent and saves.
    const macStart = resolveThemeSettings(mac.settings()).theme;
    const webStart = resolveThemeSettings(web.settings()).theme;
    saveCustomTheme(
      web,
      { ...webStart, light: { ...webStart.light, accent: '#205080' } },
      webStart,
    );
    await vi.waitFor(() =>
      expect(resolveThemeSettings(mac.settings()).theme.light.accent).toBe('#205080'),
    );
    // The Mac's draft still has the old accent; saving it writes only the background.
    saveCustomTheme(mac, { ...macStart, light: { ...macStart.light, bg: '#f4f1ea' } }, macStart);
    for (const each of [mac, web]) {
      await vi.waitFor(() => {
        const theme = resolveThemeSettings(each.settings()).theme;
        expect(theme.light.accent).toBe('#205080');
        expect(theme.light.bg).toBe('#f4f1ea');
      });
    }
  });

  it('does not bring back a theme deleted on another device while it was being edited', async () => {
    const { mac, web } = await twoDevices();
    const copy = duplicateAndChoose(mac, NORD);
    await vi.waitFor(() => expect(resolveThemeSettings(web.settings()).theme.id).toBe(copy.id));
    const start = resolveThemeSettings(mac.settings()).theme;
    deleteCustomTheme(web, start);
    await vi.waitFor(() => expect(resolveThemeSettings(mac.settings()).custom).toEqual([]));
    // The Mac's editor closes and saves what was typed: nothing comes back.
    expect(saveCustomTheme(mac, { ...start, name: 'Late edit' }, start)).toBeNull();
    for (const each of [mac, web]) {
      const resolved = resolveThemeSettings(each.settings());
      expect(resolved.custom).toEqual([]);
      expect(resolved.theme).toBe(NORD);
    }
  });

  it('falls back safely when a bad theme arrives by sync', async () => {
    const { web } = await twoDevices();
    // Another writer (an old build, an agent's clone) writes nonsense straight into the doc.
    const other = createYjs14Replica();
    const scope = GIT_DEVICE_SETTINGS;
    setSetting(other.doc, scope, 'theme.id', 'custom-broken');
    setSetting(other.doc, scope, 'theme.mode', 42);
    setSetting(other.doc, scope, `${CUSTOM_THEME_PREFIX}custom-broken`, { id: 'custom-broken' });
    setSetting(other.doc, scope, `${CUSTOM_THEME_PREFIX}custom-half`, {
      id: 'custom-half',
      name: 'Half',
      base: 'nord',
      light: { bg: 'javascript:alert(1)' },
    });
    web.replica.applyUpdate(other.encodeStateAsUpdate(), MERGED);

    await vi.waitFor(() => expect(web.settings()['theme.id']).toBe('custom-broken'));
    const resolved = resolveThemeSettings(web.settings());
    expect(resolved.theme.id).toBe('penmoss');
    expect(resolved.mode).toBe('system');
    expect(resolved.custom.map((theme) => theme.id)).toEqual(['custom-half']);
    expect(resolved.custom[0]!.light).toEqual(NORD.light);
  });
});
