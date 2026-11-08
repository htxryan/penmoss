/**
 * The git engine page's two roles (T50 G7, A872, A876), each in a WebView of its own that only
 * the app talks to:
 *
 * - `engine`: one notebook's engine and notes server (`host.ts`, `server.ts`);
 * - `guard`: the app's commit check (A876), as the Mac's main process runs `purge-check`: what a
 *   commit deletes for good, which logs it shrinks, what is deleted for good at head, and the
 *   titles the owner check names. It reads the head through the app's JGit, never through the
 *   engine page, and holds nothing between calls, so an engine page that misbehaves cannot shape
 *   its verdict.
 */
import {
  commitPurges,
  purgedAt,
  titlesAt,
  type HeadReader,
} from '@penmoss/git-notebook/purge-check';
import type { WriterSecrets } from '@penmoss/git-notebook';
import type { EngineKv } from '../../../../web/src/sources/engine-store';
import { BridgeTransport } from './bridge-transport';
import { Channel, ChannelError, type FramePort } from './channel';
import { AndroidGitHost, PULL_EVERY_MIN, PUSH_DELAY_S, type GitSyncStatus } from './host';
import { fromBase64 } from 'lib0/buffer';

/** Where the engine page keeps a notebook's state: IndexedDB in the app, memory in the tests. */
export interface PageStorage {
  open(notebookId: string): Promise<EngineKv>;
  forget(notebookId: string): Promise<void>;
}

const NOTEBOOK_ID = /^[0-9A-Z]{26}$/;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChannelError('invalid_request', 'Expected an object');
  }
  return value as Record<string, unknown>;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new ChannelError('invalid_request', `${name} must be text`);
  return value;
};

/** The engine role: one notebook per page. Returns the channel (tests drive it directly). */
export function serveEngine(port: FramePort, storage: PageStorage): Channel {
  let host: AndroidGitHost | null = null;
  let opened: string | null = null;
  const need = () => {
    if (!host) throw new ChannelError('not_open', 'The notebook is not open yet');
    return host;
  };
  /**
   * Old copies' updates as their parts arrive (A886), by the app's token for that one sequence of
   * calls: each update's base64, joined in order. Two sequences for the same note (a recovery
   * pass and Save their text) never mix. One the app gave up on is dropped once more wait.
   */
  const parts = new Map<string, string[]>();
  const MAX_SEQUENCES = 16;
  const tokenOf = (input: Record<string, unknown>): string => {
    const token = text(input['token'], 'token');
    if (token.length === 0 || token.length > 64)
      throw new ChannelError('invalid_request', 'Not a token');
    return token;
  };
  const gather = (input: Record<string, unknown>): string[] => {
    const token = tokenOf(input);
    const pieces = input['pieces'];
    if (!Array.isArray(pieces)) throw new ChannelError('invalid_request', 'pieces must be a list');
    if (input['first'] === true || !parts.has(token)) {
      parts.delete(token);
      parts.set(token, []);
      while (parts.size > MAX_SEQUENCES) parts.delete(parts.keys().next().value!);
    }
    const updates = parts.get(token)!;
    for (const piece of pieces as unknown[]) {
      const each = record(piece);
      const n = each['n'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > updates.length) {
        throw new ChannelError('invalid_request', 'A piece out of order');
      }
      updates[n] = (updates[n] ?? '') + text(each['s'], 's');
    }
    return updates;
  };
  const decoded = (updates: readonly string[], token: string): Uint8Array[] => {
    parts.delete(token);
    return updates.map((each) => {
      try {
        return fromBase64(each);
      } catch {
        throw new ChannelError('invalid_request', 'Malformed update');
      }
    });
  };
  const channel: Channel = new Channel(port, {
    open: async (args) => {
      const input = record(args);
      const notebookId = text(input['notebookId'], 'notebookId');
      if (!NOTEBOOK_ID.test(notebookId))
        throw new ChannelError('invalid_request', 'Not a notebook id');
      if (host) {
        if (opened !== notebookId)
          throw new ChannelError('invalid_request', 'This page holds another notebook');
        return { epoch: host.serverForTests?.epoch ?? null };
      }
      const root = text(input['root'] ?? '', 'root');
      const transport = new BridgeTransport(channel, root);
      const secrets: WriterSecrets = {
        get: async () => {
          const secret = await channel.call('secret.get', null, 30_000);
          return typeof secret === 'string' ? secret : null;
        },
        set: async (secret) => {
          await channel.call('secret.set', secret, 30_000);
        },
      };
      const kv = await storage.open(notebookId);
      const made = new AndroidGitHost({
        notebookId,
        name: text(input['name'] ?? 'Notebook', 'name'),
        create: input['create'] === true,
        host: text(input['host'] ?? 'the git host', 'host'),
        label: text(input['label'] ?? 'Penmoss for Android', 'label'),
        pushDelayS: Number(input['pushDelayS'] ?? PUSH_DELAY_S),
        pullEveryMin: Number(input['pullEveryMin'] ?? PULL_EVERY_MIN),
        front: input['front'] === true,
        // Tests only shorten it; the app never sends one.
        ...(typeof input['onlineSettleMs'] === 'number'
          ? { onlineSettleMs: input['onlineSettleMs'] }
          : {}),
        ...(typeof input['closingSyncMs'] === 'number'
          ? { closingSyncMs: input['closingSyncMs'] }
          : {}),
        transport,
        secrets,
        kv,
        // The owner check is the app's: its words, its prompt; the page only waits for it.
        confirmPurge: async (noteId) => {
          await channel.call('owner.purge', { noteId });
        },
        confirmRestore: async (noteId, version, revert) => {
          await channel.call('owner.restore', { noteId, version, revert });
        },
        onStatus: (status: GitSyncStatus) => channel.emit('status', status),
        onChanged: () => channel.emit('changed'),
        log: (message) => channel.emit('log', message),
        roomEpochs: Array.isArray(input['roomEpochs'])
          ? (input['roomEpochs'] as unknown[]).filter((each) => typeof each === 'string')
          : [],
        // Room keeps a copy withheld from the push (A886) before it leaves the notebook.
        withhold: async (copies) => {
          await channel.call(
            'copy.withhold',
            {
              copies: copies.map((copy) => ({
                noteId: copy.id,
                origin: copy.origin,
                title: copy.title,
                folderId: copy.folderId,
                update: copy.update,
              })),
            },
            60_000,
          );
        },
      });
      const started = await made.start();
      host = made;
      opened = notebookId;
      return started;
    },
    http: async (args) => {
      const input = record(args);
      const headers = (
        typeof input['headers'] === 'object' && input['headers'] !== null ? input['headers'] : {}
      ) as Record<string, unknown>;
      const reply = await need().request({
        method: text(input['method'], 'method'),
        path: text(input['path'], 'path'),
        headers: Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, String(value)]),
        ),
        body: input['body'] instanceof Uint8Array ? input['body'] : null,
      });
      return { status: reply.status, headers: reply.headers, body: reply.body };
    },
    sync: async (args) => {
      const input = args === null ? {} : record(args);
      const running = need();
      const limit = typeof input['limitMs'] === 'number' ? input['limitMs'] : undefined;
      await running.syncNow(input['reason'] === 'background' ? 'background' : 'now', limit);
      await running.settled();
      return running.status;
    },
    cadence: (args) => {
      const input = record(args);
      need().setCadence(Number(input['pushDelayS']), Number(input['pullEveryMin']));
      return null;
    },
    front: (args) => {
      need().setFront(record(args)['front'] === true);
      return null;
    },
    keep: async (args) => {
      const input = record(args);
      await need().keep(text(input['noteId'], 'noteId'), input['keep'] !== false);
      return null;
    },
    // Room's old copies (A886) as the strings Room keeps (base64), in parts so none passes the
    // frame limit: Kotlin never decodes them (A11). `recover.part` gathers, the last call reads.
    'recover.part': (args) => {
      gather(record(args));
      return null;
    },
    recover: async (args) => {
      const input = record(args);
      const noteId = text(input['noteId'], 'noteId');
      const updates = decoded(gather(input), tokenOf(input));
      const folder = input['folderId'];
      return need().recover({
        noteId,
        updates,
        folderId: typeof folder === 'string' ? folder : null,
      });
    },
    'recover.text': (args) => {
      const input = record(args);
      const noteId = text(input['noteId'], 'noteId');
      // What can be read of it: an update that does not decode is left out.
      const updates = gather(input).flatMap((each) => {
        try {
          return [fromBase64(each)];
        } catch {
          return [];
        }
      });
      parts.delete(tokenOf(input));
      return need().oldCopyText(noteId, updates);
    },
    // Keep and sync of a copy withheld from the push (A886): Room's rows of it, in parts.
    'copy.keep': async (args) => {
      const input = record(args);
      const noteId = text(input['noteId'], 'noteId');
      const updates = decoded(gather(input), tokenOf(input));
      const folder = input['folderId'];
      return need().keepCopy({
        noteId,
        origin: text(input['origin'], 'origin'),
        folderId: typeof folder === 'string' ? folder : null,
        updates,
      });
    },
    'copy.forget': async (args) => {
      await need().forgetCopy(text(record(args)['noteId'], 'noteId'));
      return null;
    },
    'recover.release': (args) => {
      need().releaseOldCopy(text(record(args)['noteId'], 'noteId'));
      return null;
    },
    'recover.end': () => {
      need().endOldCopies();
      return null;
    },
    status: () => need().status,
    pending: () => [...need().pending()],
    // `leaving`: the app really leaves the screen (#174 delta review); a plain pause does not.
    close: async (args) => {
      const leaving =
        typeof args === 'object' &&
        args !== null &&
        (args as { leaving?: unknown }).leaving === true;
      if (host) await host.beforeClose(leaving);
      return null;
    },
    stop: () => {
      host?.stop();
      return null;
    },
    forget: async (args) => {
      const notebookId = text(record(args)['notebookId'], 'notebookId');
      if (!NOTEBOOK_ID.test(notebookId))
        throw new ChannelError('invalid_request', 'Not a notebook id');
      if (opened === notebookId) {
        host?.stop();
        host = null;
        opened = null;
      }
      await storage.forget(notebookId);
      return null;
    },
  });
  return channel;
}

/** The guard role (A876): stateless checks over the head as the app's JGit reads it. */
export function serveGuard(port: FramePort): Channel {
  const reader = (localId: string): HeadReader => ({
    list: async (head) => {
      const pairs = await channel.call('head.list', [localId, head], 120_000);
      return new Map(
        (Array.isArray(pairs) ? pairs : []).filter(
          (pair): pair is [string, string] =>
            Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
        ),
      );
    },
    read: async (head, paths) => {
      const out = new Map<string, Uint8Array>();
      // In parts, so no frame gets large (a notebook's workspace logs, or one note's).
      for (let at = 0; at < paths.length; at += 200) {
        const pairs = await channel.call(
          'head.read',
          [localId, head, paths.slice(at, at + 200)],
          120_000,
        );
        for (const pair of Array.isArray(pairs) ? pairs : []) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] instanceof Uint8Array) {
            out.set(pair[0], pair[1].slice());
          }
        }
      }
      return out;
    },
  });
  const target = (args: unknown) => {
    const input = record(args);
    const head = input['head'];
    if (head !== null && typeof head !== 'string')
      throw new ChannelError('invalid_request', 'head must be a commit or null');
    return {
      input,
      localId: text(input['localId'], 'localId'),
      root: text(input['root'] ?? '', 'root'),
      head,
    };
  };
  const channel: Channel = new Channel(port, {
    'guard.commit': async (args) => {
      const { input, localId, root, head } = target(args);
      const raw = input['changes'];
      if (!Array.isArray(raw)) throw new ChannelError('invalid_request', 'changes must be a list');
      const changes = new Map<string, Uint8Array | null>();
      for (const pair of raw as unknown[]) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string')
          throw new ChannelError('invalid_request', 'Not a change');
        const bytes: unknown = pair[1];
        if (bytes !== null && !(bytes instanceof Uint8Array))
          throw new ChannelError('invalid_request', 'Not file bytes');
        changes.set(pair[0], bytes);
      }
      return commitPurges(reader(localId), root, head, changes);
    },
    'guard.purgedAt': async (args) => {
      const { localId, root, head } = target(args);
      return [...(await purgedAt(reader(localId), root, head))].sort();
    },
    'guard.titles': async (args) => {
      const { input, localId, root, head } = target(args);
      const ids = Array.isArray(input['ids'])
        ? input['ids'].filter((id): id is string => typeof id === 'string')
        : [];
      return [...(await titlesAt(reader(localId), root, head, ids))];
    },
  });
  return channel;
}
