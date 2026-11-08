/** Small notebooks for the engine's unit tests: one in-memory remote, clones of it. */
import { readTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import {
  GitNotebookEngine,
  type EngineOptions,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  NotebookOps,
  type WriterKind,
} from '../../src';

export const NOTEBOOK_ID = '01JBNOTEBOOK00000000000001';

export interface TestClone {
  readonly name: string;
  readonly engine: GitNotebookEngine;
  readonly ops: NotebookOps;
  readonly storage: MemoryStorage;
  readonly secrets: MemorySecrets;
  readonly transport: MemoryTransport;
}

export function testNotebook(options: { readonly dir?: string; readonly branch?: string } = {}) {
  const remote = new MemoryRemote();
  const branch = options.branch ?? 'main';
  const root = options.dir ? `${options.dir}/` : '';
  let time = Date.UTC(2026, 9, 29, 14, 0, 0);
  let ids = 0;
  const clock = () => time;
  /** ULIDs in creation order: the time part grows, so a later note has a later id. */
  const newId = () => {
    ids++;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let head = '';
    for (let rest = time + ids, i = 0; i < 10; i++) {
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
  const transport = (name: string) =>
    new MemoryTransport({
      remote,
      branch,
      root,
      author: { name: `Penmoss ${name}`, email: `${name.toLowerCase()}@example.invalid` },
      clock,
    });
  const open = async (
    name: string,
    input: {
      readonly kind?: WriterKind;
      readonly create?: boolean;
      readonly storage?: MemoryStorage;
      readonly secrets?: MemorySecrets;
      readonly transport?: MemoryTransport;
      /** More engine options (a log size cap, a deliberate bug). */
      readonly engine?: Pick<
        EngineOptions,
        'maxLogBytes' | 'mutation' | 'log' | 'retireWriterAfterIds' | 'maxActorBytes'
      >;
    } = {},
  ): Promise<TestClone> => {
    const storage = input.storage ?? new MemoryStorage();
    const secrets = input.secrets ?? new MemorySecrets();
    const t = input.transport ?? transport(name);
    const engine = await GitNotebookEngine.open({
      transport: t,
      storage,
      secrets,
      writer: { kind: input.kind ?? 'device', label: name },
      ...(input.create ? { create: { id: NOTEBOOK_ID, name: 'Work' } } : {}),
      clock,
      newId,
      ...input.engine,
    });
    return {
      name,
      engine,
      ops: new NotebookOps(engine, clock, newId),
      storage,
      secrets,
      transport: t,
    };
  };
  return {
    remote,
    branch,
    root,
    clock,
    newId,
    transport,
    open,
    tick(ms = 60_000) {
      time += ms;
    },
    head: () => remote.branches.get(branch) ?? null,
    /** Rendered files at head (relative to the notebook's directory). */
    rendered(): Map<string, string> {
      const head = remote.branches.get(branch);
      const out = new Map<string, string>();
      if (!head) return out;
      for (const [path, blob] of remote.commits.get(head)!.tree) {
        if (!path.startsWith(root) || !path.endsWith('.md') || path.startsWith(`${root}.penmoss/`))
          continue;
        out.set(path.slice(root.length), new TextDecoder().decode(remote.blobs.get(blob)));
      }
      return out;
    },
    files(): string[] {
      const head = remote.branches.get(branch);
      return head ? [...remote.commits.get(head)!.tree.keys()].sort() : [];
    },
  };
}

export function titles(clone: TestClone): string[] {
  const registered = new Set(readWorkspace(clone.engine.replica.workspace).notes.map((n) => n.id));
  return clone.engine.replica
    .noteIds()
    .filter((id) => registered.has(id))
    .map((id) => readTitle(clone.engine.replica.note(id)!))
    .sort();
}
