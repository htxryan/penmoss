/**
 * What a git notebook's remote holds (T59): the suite's stand-in for asking the server. A
 * reader clones the bare repository afresh, takes in every writer's files, and never pushes, so
 * reading changes nothing a spec looks at. The rendered markdown is read from the branch as it
 * is, with system git.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '@penmoss/git-notebook';
import { NodeGitTransport } from '@penmoss/git-notebook/node';
import {
  mergedSettings,
  readSettings,
  readWorkspace,
  type WorkspaceSnapshot,
} from '@penmoss/model/workspace';
import { readTitle } from '@penmoss/model/note';
import type { GitHost } from './git-host';

/** Thrown before a reader's push: a reader never writes to the remote. */
class ReadOnly extends Error {}

/** A notebook as the remote holds it now. */
export interface RemoteNotebook {
  readonly ops: NotebookOps;
  readonly workspace: WorkspaceSnapshot;
  /** A note's title, or null when the remote has no such note. */
  title(id: string): string | null;
  /**
   * A setting as the Mac app reads it (the notebook's own, the device's, and the Macs' own copy of
   * the look and layout over them, A827, A1605), or one map's alone when `map` names it.
   */
  setting(key: string, map?: 'notebook' | 'device' | 'desktop' | 'mobile'): unknown;
}

/** Reads the notebook at `remote` as another device would after a pull. */
export async function readRemote(host: GitHost, remote: string): Promise<RemoteNotebook> {
  const dir = mkdtempSync(join(host.root, 'reader-'));
  try {
    const transport = new NodeGitTransport({
      gitDir: join(dir, 'repo.git'),
      remote,
      branch: 'main',
      root: '',
      author: { name: 'Reader', email: 'reader@example.invalid' },
      env: host.env,
      sign: false,
    });
    await transport.init();
    const engine = await GitNotebookEngine.open({
      transport,
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Reader' },
    });
    try {
      await engine.sync({
        beforePush: () => {
          throw new ReadOnly('A reader never pushes.');
        },
      });
    } catch (error) {
      if (!(error instanceof ReadOnly)) throw error;
    }
    const ops = new NotebookOps(engine);
    const workspace = readWorkspace(ops.workspace);
    return {
      ops,
      workspace,
      title: (id) => {
        const doc = ops.note(id);
        return doc ? readTitle(doc) : null;
      },
      setting: (key, map) =>
        map ? readSettings(ops.workspace, map)[key] : mergedSettings(ops.workspace, 'desktop')[key],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The branch's files (paths from the repository's top), or none before its first push. */
export function remoteFiles(host: GitHost, remote: string): string[] {
  const bare = remote.replace(/^file:\/\//, '');
  try {
    return host.git(bare, ['ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** A file's text on the branch, or null when it has none there. */
function remoteFile(host: GitHost, remote: string, path: string): string | null {
  const bare = remote.replace(/^file:\/\//, '');
  try {
    return host.git(bare, ['show', `main:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The rendered markdown of note `id` on the branch (its file names it in the front matter),
 * or null while the branch has none.
 */
export function remoteMarkdown(host: GitHost, remote: string, id: string): string | null {
  for (const path of remoteFiles(host, remote)) {
    if (!path.endsWith('.md')) continue;
    const text = remoteFile(host, remote, path);
    if (text && new RegExp(`^id: ${id}$`, 'm').test(text)) return text;
  }
  return null;
}
