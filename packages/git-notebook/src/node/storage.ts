/**
 * A notebook's local state in files (T50 G2): what the CLI and the local MCP keep in
 * `~/.penmoss/git/<localId>/state/`. Every file is written to a sibling and renamed over, so a
 * crash leaves the old file or the new one, never half of one.
 *
 * Saves are ordered so a crash anywhere loses nothing (A821): first the bookkeeping, with the
 * last head it had before and every dirty mark of both; then the docs; then the bookkeeping
 * again. A crash in between makes the next sync read logs it already has (merging them again
 * changes nothing) and recompute own files for notes that may not have changed (which finds
 * nothing new), never skip a change.
 */
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EMPTY_META,
  type NotebookChange,
  type NotebookMeta,
  type NotebookSnapshot,
  type NotebookStorage,
} from '../replica';

const NOTE_FILE = /^([0-9A-Z]{26})\.yjs$/;
const ATTACHMENT_FILE = /^[0-9a-f]{64}\.[a-z0-9]{1,10}$/;

export class FileStorage implements NotebookStorage {
  private meta: NotebookMeta | null = null;
  /** Raised on every save; another process that sees it change reloads (`generation`). */
  private saves = 0;

  constructor(readonly dir: string) {}

  private get state(): string {
    return join(this.dir, 'state');
  }

  async load(): Promise<NotebookSnapshot | null> {
    const metaText = await readFile(join(this.state, 'meta.json'), 'utf8').catch(() => null);
    if (metaText === null) return null;
    const parsed = JSON.parse(metaText) as { meta: NotebookMeta; saves?: number };
    this.meta = { ...EMPTY_META, ...parsed.meta };
    this.saves = parsed.saves ?? 0;
    const workspace = await readFile(join(this.state, 'workspace.yjs')).catch(() => null);
    const notes = new Map<string, Uint8Array>();
    const names = await readdir(join(this.state, 'notes')).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const id = NOTE_FILE.exec(name)?.[1];
      if (!id) continue;
      notes.set(id, new Uint8Array(await readFile(join(this.state, 'notes', name))));
    }
    return {
      workspace: workspace ? new Uint8Array(workspace) : null,
      notes,
      meta: this.meta,
    };
  }

  async save(change: NotebookChange): Promise<void> {
    await mkdir(join(this.state, 'notes'), { recursive: true, mode: 0o700 });
    const before = this.meta;
    const docs = change.workspace !== null || change.notes.size > 0;
    if (docs && before) {
      // Until the docs are written, keep the old head and every mark (see above).
      const dirty = { ...before.dirty, ...change.meta.dirty };
      for (const [id, at] of Object.entries(before.dirty)) {
        dirty[id] = Math.max(at, change.meta.dirty[id] ?? 0);
      }
      await this.writeMeta({
        ...change.meta,
        lastHead: before.lastHead,
        dirty,
        workspaceDirty: before.workspaceDirty || change.meta.workspaceDirty,
        ownClients: [...new Set([...before.ownClients, ...change.meta.ownClients])].sort(
          (a, b) => a - b,
        ),
      });
    }
    if (change.workspace) await atomicWrite(join(this.state, 'workspace.yjs'), change.workspace);
    for (const [id, bytes] of change.notes) {
      if (!/^[0-9A-Z]{26}$/.test(id)) throw new Error(`Not a note id: ${id}`);
      const path = join(this.state, 'notes', `${id}.yjs`);
      if (bytes === null) await rm(path, { force: true });
      else await atomicWrite(path, bytes);
    }
    await this.writeMeta(change.meta);
    this.meta = change.meta;
  }

  private async writeMeta(meta: NotebookMeta): Promise<void> {
    this.saves++;
    await atomicWrite(
      join(this.state, 'meta.json'),
      new TextEncoder().encode(`${JSON.stringify({ saves: this.saves, meta })}\n`),
    );
  }

  /** How many saves the files hold: another process changed them when it moves. */
  async generation(): Promise<number> {
    const text = await readFile(join(this.state, 'meta.json'), 'utf8').catch(() => null);
    if (text === null) return 0;
    return (JSON.parse(text) as { saves?: number }).saves ?? 0;
  }

  async readAttachment(file: string): Promise<Uint8Array | null> {
    if (!ATTACHMENT_FILE.test(file)) return null;
    const bytes = await readFile(join(this.dir, 'attachments', file)).catch(() => null);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async writeAttachment(file: string, bytes: Uint8Array): Promise<void> {
    if (!ATTACHMENT_FILE.test(file)) throw new Error(`Not an attachment file name: ${file}`);
    await mkdir(join(this.dir, 'attachments'), { recursive: true, mode: 0o700 });
    await atomicWrite(join(this.dir, 'attachments', file), bytes);
  }

  /** Bytes on disk (Status): the state and the attachments, not the git clone. */
  async bytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        // A save's temporary file can be renamed between the listing and here: it isn't there now.
        else total += (await stat(path).catch(() => null))?.size ?? 0;
      }
    };
    await walk(this.state);
    await walk(join(this.dir, 'attachments'));
    return total;
  }
}

/** Writes a sibling file (0600) and renames it over `path`. */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}
