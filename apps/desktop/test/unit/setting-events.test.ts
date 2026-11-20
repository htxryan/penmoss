import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventProblem, type Props } from '@penmoss/core/analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PEN-175 ac13: the nine settings the Mac's main process writes itself are recorded by main,
// `setting <name>` with what the value may say, once the write succeeds, and never when it fails.
// Electron, the app's state and its services are stand-ins here; the code that writes and records
// each setting is the app's own.

const mocks = vi.hoisted(() => ({
  record: vi.fn<(kind: string, name: string, props: Props) => boolean>(() => true),
  savePreferences: vi.fn<(file: string, preferences: unknown) => void>(),
  gitUpdate: vi.fn<(localId: unknown, patch: unknown) => Promise<unknown>>(),
  meaningSetEnabled: vi.fn<(on: boolean) => Promise<unknown>>(),
  register: vi.fn<(accelerator: string, run: () => void) => boolean>(() => true),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  state: {
    preferences: {},
    holdingInput: false,
    reopening: false,
    quitting: false,
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showMessageBox: mocks.showMessageBox },
  globalShortcut: {
    register: mocks.register,
    isRegistered: () => true,
    unregister: () => undefined,
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }) },
  Tray: class {},
}));
vi.mock('../../src/app-state', () => ({
  state: mocks.state,
  log: () => undefined,
  preferencesFile: () => '/nowhere/preferences.json',
  mac: false,
  macWindows: false,
  fullScreens: new Set(),
  windows: { all: () => [], active: null, kindOf: () => 'main', remove: () => undefined },
}));
vi.mock('../../src/services', () => ({
  analytics: { record: mocks.record },
  gitNotebooks: { update: mocks.gitUpdate },
  githubToken: {},
  meaning: { setEnabled: mocks.meaningSetEnabled },
}));
vi.mock('../../src/preferences', () => ({ savePreferences: mocks.savePreferences }));
vi.mock('../../src/ipc', () => ({ sendEvent: () => undefined }));
vi.mock('../../src/windows/main-window', () => ({
  createMainWindow: () => ({ once: () => undefined }),
  deliverToMain: () => undefined,
  openInMain: () => null,
}));
vi.mock('../../src/windows/note-window', () => ({
  createNoteWindow: () => ({ once: () => undefined }),
}));
vi.mock('../../src/windows/capture-window', () => ({ showCapture: () => undefined }));
vi.mock('../../src/windows/window-common', () => ({ storeNow: () => Promise.resolve('saved') }));

const { setMenuBarIcon } = await import('../../src/tray-control');
const { setCompactTitleBar } = await import('../../src/mac-window-control');
const { setHotkey } = await import('../../src/capture-hotkey');
const { registerGitIpc } = await import('../../src/ipc/git');
const { registerMeaningIpc } = await import('../../src/ipc/meaning');
const { Updates } = await import('../../src/updater');
const { settingValueProps } = await import('@penmoss/core/analytics');

type Handler = (call: { event: unknown; gesture: boolean }, ...args: unknown[]) => unknown;

/** The handlers a register function gives, by name. */
function handlers(register: (ipc: never, ...rest: never[]) => void): Map<string, Handler> {
  const found = new Map<string, Handler>();
  const ipc = {
    handle: (name: string, fn: Handler) => found.set(name, fn),
    on: () => undefined,
  };
  (register as (ipc: unknown, ...rest: unknown[]) => void)(ipc, () => true);
  return found;
}

/** The settings main recorded, as `name` and props. */
const settings = () =>
  mocks.record.mock.calls
    .filter(([kind]) => kind === 'setting')
    .map(([, name, props]) => ({ name, props }));

/** Each recorded setting passes core's check, as main stores it. */
function expectValid(): void {
  for (const { name, props } of settings()) {
    const problem = eventProblem({
      session: '0123456789abcdef',
      seq: 0,
      at: 1,
      client: 'mac',
      actor: 'person',
      version: '1.4.0',
      channel: 'stable',
      os: 'macos',
      osVersion: '26.1',
      kind: 'setting',
      name,
      props,
    });
    expect(problem, name).toBeNull();
  }
}

const failSave = () =>
  mocks.savePreferences.mockImplementationOnce(() => {
    throw new Error('disk full');
  });

beforeEach(() => {
  mocks.record.mockClear();
  mocks.savePreferences.mockReset();
  mocks.gitUpdate.mockReset();
  mocks.meaningSetEnabled.mockReset();
  mocks.showMessageBox.mockClear();
  mocks.state.preferences = {};
  mocks.state.reopening = false;
  mocks.state.quitting = false;
});
afterEach(() => expectValid());

describe('settingValueProps (core, shared with the page)', () => {
  it('sends a switch, a whole number and a listed word as themselves, other text as changed', () => {
    expect(settingValueProps('menuBar.icon', false)).toEqual({ value: false });
    expect(settingValueProps('git.pushAfter', 30)).toEqual({ value: 30 });
    expect(settingValueProps('updates.channel', 'alpha')).toEqual({ value: 'alpha' });
    expect(settingValueProps('updates.channel', 'nightly')).toEqual({ changed: true });
    expect(settingValueProps('capture.hotkey', 'Control+Alt+Space')).toEqual({ changed: true });
    expect(settingValueProps('capture.hotkey', null)).toEqual({ changed: true });
  });
});

describe('menuBar.icon (tray-control.ts)', () => {
  it('is recorded once Show in the Menu Bar is saved', () => {
    expect(setMenuBarIcon(false)).toBe(false);
    expect(mocks.savePreferences).toHaveBeenCalledOnce();
    expect(settings()).toEqual([{ name: 'menuBar.icon', props: { value: false } }]);
    expect(setMenuBarIcon(true)).toBe(true);
    expect(settings().at(-1)).toEqual({ name: 'menuBar.icon', props: { value: true } });
  });

  it('records nothing when the save fails, or nothing changes', () => {
    failSave();
    expect(setMenuBarIcon(false)).toBe(true);
    expect(setMenuBarIcon(true)).toBe(true);
    expect(settings()).toEqual([]);
  });
});

describe('titleBar.compact (mac-window-control.ts)', () => {
  const from = { isDestroyed: () => false } as never;

  it('is recorded once saved, before the windows reopen', async () => {
    await expect(setCompactTitleBar(from, false)).resolves.toEqual({
      compact: false,
      reopened: true,
    });
    expect(settings()).toEqual([{ name: 'titleBar.compact', props: { value: false } }]);
    // The windows reopen after the page has its answer, and the setting was recorded by then.
    expect(mocks.state.reopening).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.state.reopening).toBe(false);
  });

  it('records nothing when the save fails, or the person cancels', async () => {
    failSave();
    await expect(setCompactTitleBar(from, false)).resolves.toEqual({
      compact: true,
      reopened: false,
    });
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await setCompactTitleBar(from, false);
    expect(settings()).toEqual([]);
  });
});

describe('capture.hotkey (capture-hotkey.ts)', () => {
  it('is recorded once saved, only as changed', () => {
    expect(setHotkey('Control+Alt+K')).not.toHaveProperty('error');
    expect(mocks.savePreferences).toHaveBeenCalledOnce();
    expect(settings()).toEqual([{ name: 'capture.hotkey', props: { changed: true } }]);
  });

  it('records nothing when the keys are refused, taken or not saved', () => {
    expect(setHotkey('not keys')).toHaveProperty('error');
    mocks.register.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(setHotkey('Control+Alt+J')).toHaveProperty('error');
    failSave();
    expect(() => setHotkey('Control+Alt+L')).toThrow('disk full');
    expect(settings()).toEqual([]);
  });
});

describe('git.pushAfter, git.pullEvery and git.signCommits (ipc/git.ts)', () => {
  const update = handlers(registerGitIpc).get('gitUpdate')!;
  const call = { event: {}, gesture: true };
  const view = { localId: 'n1', pushDelayS: 30, pullEveryMin: 5, sign: false };

  it('records each of the three once the notebook is written, as it now has it', async () => {
    mocks.gitUpdate.mockResolvedValue({ ok: true, value: view });
    await update(call, 'n1', { pushDelayS: 30 });
    await update(call, 'n1', { pullEveryMin: 5 });
    await update(call, 'n1', { sign: false });
    expect(settings()).toEqual([
      { name: 'git.pushAfter', props: { value: 30 } },
      { name: 'git.pullEvery', props: { value: 5 } },
      { name: 'git.signCommits', props: { value: false } },
    ]);
  });

  it('records nothing when the write is refused, or for a rename, a branch or an identity', async () => {
    mocks.gitUpdate.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_request' } });
    await update(call, 'n1', { pushDelayS: 2 });
    mocks.gitUpdate.mockResolvedValue({ ok: true, value: view });
    await update(call, 'n1', { name: 'Work' });
    await update(call, 'n1', { branchName: 'Work' });
    await update(call, 'n1', { author: null });
    expect(settings()).toEqual([]);
  });
});

describe('meaning.enabled (ipc/meaning.ts)', () => {
  const setEnabled = handlers(registerMeaningIpc).get('meaningSetEnabled')!;
  const call = { event: {}, gesture: true };

  it('is recorded once the service has the switch', async () => {
    mocks.meaningSetEnabled.mockResolvedValue({ state: 'off', enabled: false });
    await expect(setEnabled(call, false)).resolves.toEqual({ state: 'off', enabled: false });
    expect(settings()).toEqual([{ name: 'meaning.enabled', props: { value: false } }]);
  });

  it('records nothing when the write fails, or the value is not a switch', async () => {
    mocks.meaningSetEnabled.mockRejectedValueOnce(new Error('service gone'));
    await expect(setEnabled(call, true)).rejects.toThrow('service gone');
    await expect(setEnabled(call, 'yes')).resolves.toBeNull();
    expect(settings()).toEqual([]);
  });
});

describe('updates.auto and updates.channel (updater.ts)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'penmoss-setting-events-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const updates = (at: string) =>
    new Updates({
      mode: () => 'development',
      dir: at,
      log: () => undefined,
      recordSetting: (name, value) => mocks.record('setting', name, settingValueProps(name, value)),
    });

  it('records the switch and the channel once updates.json is written', async () => {
    const kept = updates(dir);
    await kept.setAuto(true);
    await kept.setChannel('alpha');
    // The channel it already has: nothing written, nothing recorded.
    await kept.setChannel('alpha');
    expect(settings()).toEqual([
      { name: 'updates.auto', props: { value: true } },
      { name: 'updates.channel', props: { value: 'alpha' } },
    ]);
  });

  it('records nothing when updates.json cannot be written', async () => {
    // Its folder is a file: the write fails.
    const file = join(dir, 'not-a-folder');
    await writeFile(file, '');
    const kept = updates(file);
    await expect(kept.setAuto(true)).rejects.toThrow();
    await expect(kept.setChannel('alpha')).rejects.toThrow();
    expect(settings()).toEqual([]);
  });
});
