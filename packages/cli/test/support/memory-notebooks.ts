/**
 * Git notebooks in memory for the CLI's unit tests: each a real `LocalNotebook` over a real engine
 * and `MemoryTransport`, so commands run on the notes API as they do on a clone (A843), without
 * git or files. `notebook.test.ts` runs the same commands over system git.
 */
import {
  GitNotebookEngine,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  NotebookOps,
} from '@penmoss/git-notebook';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import type { NotebookIo, NotebookSyncSummary } from '../../src/io';

/** 22 Oct 2026, 12:00 UTC: when every test notebook's clock starts. */
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

const SYNCED: Omit<NotebookSyncSummary, 'name'> = {
  commit: null,
  head: null,
  pulled: 0,
  purged: 0,
  handEdits: [],
  copies: [],
  skipped: {},
  renderSkipped: false,
  attempts: 1,
  filterIgnored: false,
  warnings: [],
};

export interface MemoryNotebook {
  readonly name: string;
  readonly notebook: LocalNotebook;
  readonly engine: GitNotebookEngine;
  /** Moves the clock on (default a minute). */
  tick(ms?: number): void;
}

/** One notebook in memory, made by an agent's clone named Codex. */
export async function memoryNotebook(name = 'notes'): Promise<MemoryNotebook> {
  let time = T0;
  let ids = 0;
  const clock = () => time;
  /** ULIDs in creation order, the same in every run. */
  const newId = () => {
    ids++;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let head = '';
    for (let rest = time, i = 0; i < 10; i++) {
      head = alphabet[rest % 32] + head;
      rest = Math.floor(rest / 32);
    }
    let tail = '';
    for (let rest = ids, i = 0; i < 16; i++) {
      tail = alphabet[rest % 32] + tail;
      rest = Math.floor(rest / 32);
    }
    return head + tail;
  };
  const engine = await GitNotebookEngine.open({
    transport: new MemoryTransport({
      remote: new MemoryRemote(),
      branch: 'main',
      root: '',
      author: { name: 'Penmoss Codex', email: 'codex@example.invalid' },
      clock,
    }),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: { kind: 'agent', label: 'Codex' },
    create: { id: '01JBNOTEBOOK00000000000001', name: 'Work' },
    clock,
    newId,
  });
  const notebook = new LocalNotebook(
    new NotebookOps(engine, clock, newId),
    clock,
    async () => void (await engine.sync()),
    { side: 'cli' },
  );
  return {
    name,
    notebook,
    engine,
    tick(ms = 60_000) {
      time += ms;
    },
  };
}

/** What a command did with its notebook: which one, what for, its syncs and saves. */
interface Opened {
  readonly name: string;
  readonly what: string;
  syncs: number;
  saves: number;
}

/**
 * `NotebookIo` over notebooks in memory: a command's session is the notebook itself, and its
 * sync is the engine's. `opened` records each session.
 */
export function memoryNotebooks(notebooks: readonly MemoryNotebook[]) {
  const opened: Opened[] = [];
  const io: Pick<NotebookIo, 'list' | 'session'> = {
    list: () =>
      Promise.resolve(
        notebooks.map(({ name }) => ({
          name,
          localId: `id-${name}`,
          remote: `https://github.com/ryan/${name}.git`,
          branch: 'main',
          dir: '',
          writer: { kind: 'agent' as const, label: 'Codex' },
        })),
      ),
    session: (name, what) => {
      const found = notebooks.find((each) => each.name === name);
      if (!found) return Promise.reject(new Error(`no notebook ${name}`));
      const use: Opened = { name, what, syncs: 0, saves: 0 };
      opened.push(use);
      return Promise.resolve({
        notebook: found.notebook,
        save: async () => {
          use.saves++;
          await found.engine.save();
        },
        sync: async () => {
          use.syncs++;
          await found.engine.sync();
          return { ...SYNCED, name };
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return { notebooks: io as NotebookIo, opened };
}
