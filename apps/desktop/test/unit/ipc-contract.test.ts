import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import { IpcHandlers, sendEvent } from '../../src/ipc';
import { EVENT, INVOKE, NEEDS_A_PERSON, SEND, type Caller } from '../../src/ipc-contract';

// The IPC contract (A224, A503, A712, A1479): every channel's guard and gesture rule, written
// out here so that a change to who may call what shows in the diff.

const NOT_CONFIRMED = { ok: false, message: NEEDS_A_PERSON.error.message };
const BROWSE_NOT_CONFIRMED = {
  ok: false,
  error: { reason: 'github', message: NEEDS_A_PERSON.error.message },
};

/** [who may call, the gesture rule (none, the handler's, or what main answers without one)]. */
const POLICY: Record<keyof typeof INVOKE, [Caller, 'none' | 'handler' | { refused: unknown }]> = {
  menuCommandPending: ['app', 'none'],
  clipboardWrite: ['app', 'handler'],
  windowState: ['mac', 'none'],
  keepOnTop: ['mac', 'none'],
  compactTitleBar: ['mac', { refused: null }],
  menuBarIconGet: ['mac', 'none'],
  menuBarIconSet: ['mac', { refused: null }],
  feedbackCapture: ['window', 'none'],
  feedbackFile: ['window', 'none'],
  githubTokenStatus: ['window', 'none'],
  githubTokenSave: ['main', { refused: NOT_CONFIRMED }],
  githubTokenRemove: ['main', { refused: NOT_CONFIRMED }],
  githubSignInStatus: ['main', 'none'],
  githubSignInStart: ['main', { refused: NEEDS_A_PERSON }],
  githubSignInCancel: ['main', 'none'],
  updatesState: ['window', 'none'],
  updatesCheck: ['window', 'none'],
  updatesSetAuto: ['main', { refused: null }],
  updatesSetChannel: ['main', { refused: null }],
  updatesInstall: ['main', { refused: null }],
  updatesAcknowledge: ['main', { refused: null }],
  updatesNotes: ['window', 'none'],
  meaningStatus: ['window', 'none'],
  meaningUpdate: ['window', 'none'],
  meaningClose: ['window', 'none'],
  meaningSearch: ['window', 'none'],
  meaningSetEnabled: ['main', { refused: null }],
  meaningRemoveModel: ['main', { refused: null }],
  meaningRemoveIndex: ['main', { refused: null }],
  gitList: ['app', 'none'],
  gitAdd: ['window', 'none'],
  gitRemove: ['window', { refused: NEEDS_A_PERSON }],
  gitUpdate: ['window', 'handler'],
  gitToken: ['window', 'none'],
  gitPurgeCheck: ['window', { refused: NEEDS_A_PERSON }],
  gitRestoreCheck: ['window', { refused: NEEDS_A_PERSON }],
  gitPurgesToConfirm: ['window', 'none'],
  gitSecret: ['window', 'none'],
  gitOp: ['window', 'none'],
  gitCancel: ['window', 'none'],
  gitIdentity: ['window', 'none'],
  gitGithubRepos: ['main', 'none'],
  gitGithubFolders: ['main', 'none'],
  gitGithubOwners: ['main', 'none'],
  gitGithubCreate: ['main', { refused: BROWSE_NOT_CONFIRMED }],
  agentsList: ['main', 'none'],
  agentsConnect: ['main', { refused: NEEDS_A_PERSON }],
  agentsDisconnect: ['main', { refused: NEEDS_A_PERSON }],
  cliStatus: ['main', 'none'],
  cliInstall: ['main', { refused: NEEDS_A_PERSON }],
  cliRemove: ['main', { refused: NEEDS_A_PERSON }],
  captureHotkey: ['app', 'none'],
  captureSetHotkey: ['window', 'handler'],
};

describe('the IPC contract', () => {
  it('gives every call the guard and gesture rule written here', () => {
    const actual = Object.fromEntries(
      Object.entries(INVOKE).map(([name, rule]) => [
        name,
        [rule.from, 'gesture' in rule ? rule.gesture : 'none'],
      ]),
    );
    expect(actual).toEqual(POLICY);
  });

  it('answers a refused caller null, except where the page expects another shape', () => {
    const refused = Object.fromEntries(
      Object.entries(INVOKE)
        .filter(([, rule]) => 'refused' in rule)
        .map(([name, rule]) => [name, 'refused' in rule ? rule.refused : undefined]),
    );
    expect(refused).toEqual({ clipboardWrite: false, meaningUpdate: [], gitList: [] });
  });

  it('takes messages from the windows written here', () => {
    expect(
      Object.fromEntries(Object.entries(SEND).map(([name, rule]) => [name, rule.from])),
    ).toEqual({
      menuSet: 'window',
      themeSet: 'window',
      captureDone: 'app',
      stored: 'app',
      quickAccessSet: 'mac',
      // Main listens for a store reply itself, from the window it asked.
      saved: null,
    });
  });

  it('names every channel once', () => {
    const channels = [
      ...Object.values(INVOKE).map((rule) => rule.channel),
      ...Object.values(SEND).map((rule) => rule.channel),
      ...Object.values(EVENT),
    ];
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel).toMatch(/^penmoss:[a-z-]+(:[a-z-]+)?$/);
  });
});

/** An ipcMain that keeps its handlers, so a test can call them as a page would. */
function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const ipc = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      listeners.set(channel, fn),
  } as unknown as Pick<IpcMain, 'handle' | 'on'>;
  return { ipc, handlers, listeners };
}

const from = (caller: Caller) => ({ caller }) as unknown as IpcMainInvokeEvent & IpcMainEvent;

describe('IpcHandlers', () => {
  /** Main's check, for a sender that is the window `caller` names (main ⊂ window ⊂ app). */
  const allows = (wanted: Caller, event: IpcMainEvent | IpcMainInvokeEvent) => {
    const caller = (event as unknown as { caller: Caller }).caller;
    const rank = { app: 0, window: 1, main: 2, mac: 1 } as const;
    return wanted === 'mac' ? caller === 'mac' : rank[caller] >= rank[wanted];
  };

  it('answers a call only from the windows its rule allows', async () => {
    const { ipc, handlers } = fakeIpc();
    const calls: unknown[][] = [];
    new IpcHandlers(ipc, allows).handle('agentsList', (_call, localId) => {
      calls.push([localId]);
      return null;
    });
    const handler = handlers.get(INVOKE.agentsList.channel)!;
    expect(await handler(from('window'), 'n1')).toBeNull();
    expect(calls).toEqual([]);
    await handler(from('main'), 'n1');
    expect(calls).toEqual([['n1']]);
  });

  it("answers a refused caller with the rule's own refusal", async () => {
    const { ipc, handlers } = fakeIpc();
    const handle = new IpcHandlers(ipc, allows);
    handle.handle('meaningUpdate', () => ['n1']);
    handle.handle('clipboardWrite', () => true);
    const update = handlers.get(INVOKE.meaningUpdate.channel)!;
    expect(await update(from('window'), 'b1', [])).toEqual(['n1']);
    expect(await update(from('app'), 'b1', [])).toEqual([]);
    // Not one of the app's own pages at all.
    const write = handlers.get(INVOKE.clipboardWrite.channel)!;
    expect(await write({ caller: 'elsewhere' }, true, { text: 'x' })).toBe(false);
    expect(await write(from('app'), true, { text: 'x' })).toBe(true);
  });

  it('takes the gesture off the front, and refuses without one where the rule says', async () => {
    const { ipc, handlers } = fakeIpc();
    const seen: unknown[][] = [];
    const handle = new IpcHandlers(ipc, allows);
    handle.handle('gitRemove', ({ gesture }, localId, unpushed) => {
      seen.push([gesture, localId, unpushed]);
      return { ok: true, value: { notebookId: 'b1' } };
    });
    const remove = handlers.get(INVOKE.gitRemove.channel)!;
    expect(await remove(from('window'), false, 'n1', 2)).toEqual(NEEDS_A_PERSON);
    expect(seen).toEqual([]);
    expect(await remove(from('window'), true, 'n1', 2)).toEqual({
      ok: true,
      value: { notebookId: 'b1' },
    });
    expect(seen).toEqual([[true, 'n1', 2]]);
    // Only `true` is a gesture: a page cannot pass a truthy stand-in.
    expect(await remove(from('window'), 'yes', 'n1', 2)).toEqual(NEEDS_A_PERSON);
  });

  it('hands the gesture to a handler that decides with it, and none to calls without one', async () => {
    const { ipc, handlers } = fakeIpc();
    const seen: unknown[][] = [];
    const handle = new IpcHandlers(ipc, allows);
    handle.handle('gitUpdate', ({ gesture }, localId, patch) => {
      seen.push([gesture, localId, patch]);
      return null;
    });
    handle.handle('gitSecret', ({ gesture }, localId, value) => {
      seen.push([gesture, localId, value]);
      return null;
    });
    await handlers.get(INVOKE.gitUpdate.channel)!(from('window'), false, 'n1', { sign: true });
    await handlers.get(INVOKE.gitSecret.channel)!(from('window'), 'n1', 'secret');
    expect(seen).toEqual([
      [false, 'n1', { sign: true }],
      [false, 'n1', 'secret'],
    ]);
  });

  it('drops a message from a window its rule does not allow', () => {
    const { ipc, listeners } = fakeIpc();
    const seen: unknown[] = [];
    new IpcHandlers(ipc, allows).on('quickAccessSet', (_call, pins) => seen.push(pins));
    const listener = listeners.get(SEND.quickAccessSet.channel)!;
    listener(from('main'), [{ id: 'a', title: '' }]);
    listener(from('mac'), [{ id: 'b', title: '' }]);
    expect(seen).toEqual([[{ id: 'b', title: '' }]]);
  });

  it('refuses to register a message main checks itself', () => {
    expect(() => new IpcHandlers(fakeIpc().ipc, allows).on('saved', () => undefined)).toThrow();
  });

  it('sends events on their channel', () => {
    const sent: unknown[][] = [];
    const contents = { send: (...args: unknown[]) => sent.push(args) };
    sendEvent(contents, 'openPath', '/notes/x');
    sendEvent(contents, 'gitChanged');
    expect(sent).toEqual([[EVENT.openPath, '/notes/x'], [EVENT.gitChanged]]);
  });
});
