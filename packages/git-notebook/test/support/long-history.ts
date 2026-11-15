/**
 * A real git notebook with a long history on one note (Ryan's review of #192, finding 10): a bare
 * repository over `file://` holding `notes` other notes (each a log and a rendered file, so the
 * tree has thousands of files), then `edits` commits to one note, a Mac's and an agent's in
 * turn, each adding a line. `reader()` opens a fresh partial clone of it (`--filter=blob:none`),
 * as the Mac's is: none of the note's old blobs is here until History reads them.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import { GitNotebookEngine, MemorySecrets, MemoryStorage, NotebookOps } from '../../src';
import { NodeGitTransport } from '../../src/node/transport';
import { ISOLATED, sandbox, type Sandbox } from './git';

const NOTEBOOK = { id: '01JBNOTEBOOK00000000000001', name: 'Personal' };

export interface LongHistory {
  readonly box: Sandbox;
  readonly noteId: string;
  /** A fresh partial clone of the notebook, fetched to its head and nothing more. */
  reader(name?: string): Promise<NodeGitTransport>;
}

function transport(box: Sandbox, url: string, name: string): NodeGitTransport {
  return new NodeGitTransport({
    gitDir: join(box.dir, `clone-${name}.git`),
    remote: url,
    branch: 'main',
    root: '',
    author: { name: `Penmoss ${name}`, email: 'penmoss@example.invalid' },
    sign: false,
    env: { ...ISOLATED },
  });
}

async function writer(box: Sandbox, url: string, name: string, kind: 'device' | 'agent') {
  const t = transport(box, url, name);
  await t.init();
  const engine = await GitNotebookEngine.open({
    transport: t,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: { kind, label: name },
    ...(kind === 'device' ? { create: NOTEBOOK } : {}),
  });
  return { engine, ops: new NotebookOps(engine) };
}

function append(engine: GitNotebookEngine, noteId: string, text: string): void {
  const doc = engine.replica.note(noteId)!;
  doc.transact(() => {
    const p = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
    p.insert(0, text);
  });
}

export async function longHistory(options: {
  readonly notes: number;
  readonly edits: number;
  /** A directory to keep the built repository in and to take it from next time (measuring). */
  readonly keep?: string | undefined;
}): Promise<LongHistory> {
  const box = sandbox();
  const kept = options.keep ? join(options.keep, 'note-id') : null;
  if (kept && existsSync(kept)) {
    const url = `file://${join(options.keep!, 'personal.git')}`;
    return reading(box, url, readFileSync(kept, 'utf8'));
  }
  const remote = box.bare('personal');
  const mac = await writer(box, remote.url, 'Mac', 'device');
  for (let i = 0; i < options.notes; i++) {
    mac.ops.createNote({ title: `Note ${i}`, markdown: `Line ${i} of a note nobody opens.` });
  }
  const noteId = mac.ops.createNote({ title: 'Roadmap', markdown: 'The first line' });
  await mac.engine.sync();
  const agent = await writer(box, remote.url, 'Claude Code', 'agent');
  await agent.engine.sync();
  for (let i = 0; i < options.edits; i++) {
    const by = i % 3 === 2 ? agent : mac;
    await by.engine.sync();
    append(by.engine, noteId, `Edit ${i}: one more line`);
    await by.engine.sync();
  }
  if (kept) {
    cpSync(remote.path, join(options.keep!, 'personal.git'), { recursive: true });
    writeFileSync(kept, noteId);
  }
  return reading(box, remote.url, noteId);
}

function reading(box: Sandbox, url: string, noteId: string): LongHistory {
  return {
    box,
    noteId,
    async reader(name = 'Reader') {
      const t = transport(box, url, name);
      await t.init();
      await t.fetch();
      return t;
    },
  };
}
