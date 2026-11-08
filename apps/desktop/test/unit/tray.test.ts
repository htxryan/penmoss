import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadPreferences, savePreferences } from '../../src/hotkey';
import {
  describeMenu,
  MAX_TITLE,
  parseQuickAccess,
  pinLabel,
  pinPath,
  TRAY_ICON,
  trayMenuTemplate,
  type TrayActions,
} from '../../src/tray';

// T51 item 17 (A945, A946): the menu bar icon's menu, the pins a page sends, and the per-Mac
// preference. The Electron suite (menu-bar.spec.ts) checks them in the app.

const ID_A = '01JZ0000000000000000000001';
const ID_B = '01JZ0000000000000000000002';

function actions() {
  return {
    capture: vi.fn<() => void>(),
    today: vi.fn<() => void>(),
    openNote: vi.fn<(id: string) => void>(),
    showMain: vi.fn<() => void>(),
  } satisfies TrayActions;
}

describe('the menu bar icon’s menu', () => {
  it('without pins: Quick Capture, Open Today’s Journal, a separator, Open Penmoss', () => {
    expect(describeMenu(trayMenuTemplate([], null, actions()))).toEqual([
      { id: 'tray.capture', label: 'Quick Capture' },
      { id: 'tray.today', label: "Open Today's Journal" },
      '-',
      { id: 'tray.open', label: 'Open Penmoss' },
    ]);
  });

  it('lists the Quick Access notes in pin order, with a separator after them', () => {
    const template = trayMenuTemplate(
      [
        { id: ID_B, title: 'Groceries' },
        { id: ID_A, title: '' },
      ],
      'Control+Alt+Command+N',
      actions(),
    );
    expect(describeMenu(template)).toEqual([
      { id: 'tray.capture', label: 'Quick Capture', accelerator: 'Control+Alt+Command+N' },
      { id: 'tray.today', label: "Open Today's Journal" },
      '-',
      { id: `tray.note.${ID_B}`, label: 'Groceries' },
      { id: `tray.note.${ID_A}`, label: 'Untitled' },
      '-',
      { id: 'tray.open', label: 'Open Penmoss' },
    ]);
  });

  it('shows the capture hotkey as a hint only: the system-wide hotkey already opens it', () => {
    const [capture] = trayMenuTemplate([], 'Control+Alt+Command+N', actions());
    expect(capture).toMatchObject({
      accelerator: 'Control+Alt+Command+N',
      registerAccelerator: false,
    });
    const [none] = trayMenuTemplate([], null, actions());
    expect(none).not.toHaveProperty('accelerator');
  });

  it('runs each item’s action, a note by its id', () => {
    const run = actions();
    const template = trayMenuTemplate([{ id: ID_A, title: 'Plans' }], null, run);
    const click = (id: string) =>
      (template.find((item) => item.id === id)?.click as (() => void) | undefined)?.();
    click('tray.capture');
    click('tray.today');
    click(`tray.note.${ID_A}`);
    click('tray.open');
    expect(run.capture).toHaveBeenCalledOnce();
    expect(run.today).toHaveBeenCalledOnce();
    expect(run.openNote).toHaveBeenCalledWith(ID_A);
    expect(run.showMain).toHaveBeenCalledOnce();
  });

  it('labels a note by its title on one line, shortened, or Untitled', () => {
    expect(pinLabel('  Trip\n plans ')).toBe('Trip plans');
    expect(pinLabel(' \n')).toBe('Untitled');
    const long = pinLabel('x'.repeat(200));
    expect(long).toHaveLength(MAX_TITLE);
    expect(long.endsWith('…')).toBe(true);
  });

  it('opens a note at its in-app path', () => {
    expect(pinPath(ID_A)).toBe(`/notes/${ID_A}`);
  });
});

describe('the pins a page sends', () => {
  it('takes a list of ids and titles', () => {
    expect(
      parseQuickAccess([
        { id: ID_A, title: 'A' },
        { id: ID_B, title: '' },
      ]),
    ).toEqual([
      { id: ID_A, title: 'A' },
      { id: ID_B, title: '' },
    ]);
    expect(parseQuickAccess([])).toEqual([]);
  });

  it('refuses anything else', () => {
    expect(parseQuickAccess(null)).toBeNull();
    expect(parseQuickAccess({ id: ID_A, title: 'A' })).toBeNull();
    expect(parseQuickAccess([{ id: ID_A }])).toBeNull();
    expect(parseQuickAccess([{ id: '../x', title: 'A' }])).toBeNull();
    expect(
      parseQuickAccess([
        { id: ID_A, title: 'A' },
        { id: ID_A, title: 'B' },
      ]),
    ).toBeNull();
    // At most twenty, as quickAccess.notes holds.
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, title: '' }));
    expect(parseQuickAccess(many)).toBeNull();
    expect(parseQuickAccess(many.slice(0, 20))).toHaveLength(20);
  });

  it('keeps no more of a title than a label needs', () => {
    const [pin] = parseQuickAccess([{ id: ID_A, title: 'y'.repeat(5000) }]) ?? [];
    expect(pin?.title).toHaveLength(1000);
  });
});

describe('the menu bar icon preference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penmoss-tray-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is off unless this Mac turned it on, and survives a restart', () => {
    const file = join(dir, 'preferences.json');
    expect(loadPreferences(file).menuBarIcon).toBeUndefined();
    savePreferences(file, { compactTitleBar: false, menuBarIcon: true });
    expect(loadPreferences(file)).toEqual({ compactTitleBar: false, menuBarIcon: true });
    savePreferences(file, { menuBarIcon: false });
    expect(loadPreferences(file).menuBarIcon).toBe(false);
  });

  it('ignores a value that is not a boolean', () => {
    const file = join(dir, 'odd.json');
    writeFileSync(file, JSON.stringify({ menuBarIcon: 'yes' }));
    expect(loadPreferences(file)).toEqual({});
  });
});

describe('the template image', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));

  it('ships at 1x and 2x, copied beside boot.cjs and packed', () => {
    const base = TRAY_ICON.replace(/\.png$/, '');
    for (const name of [TRAY_ICON, `${base}@2x.png`]) {
      const file = join(root, 'resources', 'tray', name);
      expect(existsSync(file)).toBe(true);
      // A PNG, and named …Template so macOS tints it for the menu bar.
      expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
      expect(name).toMatch(/Template(@2x)?\.png$/);
    }
    expect(readFileSync(join(root, 'build.mjs'), 'utf8')).toContain("'dist/tray'");
    expect(readFileSync(join(root, 'electron-builder.config.cjs'), 'utf8')).toContain(
      "'dist/tray/*.png'",
    );
  });
});
