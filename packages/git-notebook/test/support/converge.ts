/**
 * The convergence property runs (T50 G1, #149), ported from G0's `spikes/git-notebook/converge.mjs`
 * onto the engine and the in-memory transport: three clones of one notebook (two devices and an
 * agent), 60 random offline edits and sync orders, interleaved commits whose pushes are rejected
 * and rebuilt, and every scenario G0 listed once per run at a random step. After every sync the
 * clone's full render must equal the head (a render set never misses); at the end every clone
 * holds the same docs and the history renamed no file without a cause.
 */
import { parseFrontmatter, readNoteMeta } from '@penmoss/core';
import { nameKey, noteName } from '@penmoss/core/mirror';
import { bodyMarkdown, noteBody } from '@penmoss/editor/markdown';
import { isDeleted, readTitle, setTitle } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { setFrontmatterTag } from '@penmoss/sync-client/tags';
import { readFolderTrash, readWorkspace, WorkspaceError } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import {
  GitNotebookEngine,
  Layout,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  NotebookOps,
  sameContent,
  type SyncOptions,
  type SyncReport,
  type WriterKind,
} from '../../src';
import { NOTE_NAME_ATTR } from '../../src/names';
import { WORKSPACE_PURGED } from '../../src/purge';

export class CheckError extends Error {}
const fail = (message: string): never => {
  throw new CheckError(message);
};

/** Seeded randomness (mulberry32), so a failing seed replays exactly. */
export function rngFrom(seed: number) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  });
}
export type Rng = ReturnType<typeof rngFrom>;

const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulidAt(time: number, rng: Rng): string {
  let out = '';
  for (let rest = time, i = 0; i < 10; i++) {
    out = ULID[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  for (let i = 0; i < 16; i++) out += ULID[rng.int(32)];
  return out;
}

const WORDS =
  'the quick brown fox jumps over lazy dog meeting notes project plan review budget design spike gate merge sync commit push fetch writer render folder title journal inbox agent device pixel mac branch remote'.split(
    ' ',
  );

/** Titles: words, sometimes with characters files cannot hold (A201's sanitising). */
function title(rng: Rng): string {
  const words = [rng.pick(WORDS), rng.pick(WORDS)];
  if (rng.chance(0.15))
    words.push(rng.pick(['Q3: plan?', 'a/b', 'CON', '#tag', 'Résumé', 'notes.']));
  const text = words.join(' ');
  return text[0]!.toUpperCase() + text.slice(1);
}

class Crash extends Error {}

/** One writer: an install of the notebook (its storage, its secret, its clone). */
export class Clone {
  engine!: GitNotebookEngine;
  ops!: NotebookOps;
  readonly events: Array<{ type: string; [key: string]: unknown }> = [];

  constructor(
    readonly name: string,
    readonly kind: WriterKind,
    readonly storage: MemoryStorage,
    readonly secrets: MemorySecrets,
    readonly transport: MemoryTransport,
    private readonly world: World,
  ) {}

  async open(create?: { id: string; name: string }): Promise<this> {
    const { world } = this;
    this.engine = await GitNotebookEngine.open({
      transport: this.transport,
      storage: this.storage,
      secrets: this.secrets,
      writer: { kind: this.kind, label: this.name },
      ...(create ? { create } : {}),
      clock: world.clock,
      // The writer's client id is its own, kept across reopenings (A821): chosen from the rng.
      random: world.rng,
      ...(world.bug?.clone === this.name ? { mutation: world.bug.mutation } : {}),
      newId: () => ulidAt(world.clock(), world.rng),
    });
    this.ops = new NotebookOps(this.engine, world.clock, () => ulidAt(world.clock(), world.rng));
    return this;
  }

  get replica() {
    return this.engine.replica;
  }

  liveNotes(): string[] {
    const registered = new Set(readWorkspace(this.replica.workspace).notes.map((note) => note.id));
    return this.replica
      .noteIds()
      .filter((id) => registered.has(id) && !isDeleted(this.replica.note(id)!));
  }

  folders(): string[] {
    return readWorkspace(this.replica.workspace)
      .folders.map((folder) => folder.id)
      .sort();
  }

  /** Random body edits: insert or delete text, add a paragraph (sometimes with a link), drop one. */
  editBody(noteId: string, rng: Rng, bursts = 1): void {
    const doc = this.replica.note(noteId)!;
    const root = doc.get(NOTE_ROOT);
    const others = this.liveNotes().filter((id) => id !== noteId);
    doc.transact(() => {
      for (let i = 0; i < bursts; i++) {
        const paragraphs = root
          .toArray()
          .filter((node): node is Y.Node => node instanceof Y.Node && node.name === 'paragraph');
        const roll = rng();
        if (roll < 0.5 && paragraphs.length > 0) {
          const p = rng.pick(paragraphs);
          p.insert(rng.int(p.length + 1), `${rng.pick(WORDS)} `);
        } else if (roll < 0.65 && paragraphs.length > 0) {
          const p = rng.pick(paragraphs);
          if (p.length > 2) {
            const at = rng.int(p.length - 1);
            p.delete(at, 1 + rng.int(Math.min(6, p.length - at - 1)));
          }
        } else if (roll < 0.9 || paragraphs.length < 2) {
          const p = new Y.Node('paragraph');
          root.insert(rng.int(root.length + 1), [p]);
          p.insert(0, `${rng.pick(WORDS)} ${rng.pick(WORDS)} `);
          if (others.length > 0 && rng.chance(0.3)) {
            const target = rng.pick(others);
            const link = new Y.Node('wikilink');
            p.insert(p.length, [link]);
            link.setAttr('noteId', target);
            link.setAttr('target', readTitle(this.replica.note(target)!) || 'Untitled');
            link.setAttr('heading', null);
            link.setAttr('alias', null);
          }
        } else {
          const index = root.toArray().indexOf(rng.pick(paragraphs));
          root.delete(index, 1);
        }
      }
    });
  }

  /** A picture: its bytes kept for the next sync, and a paragraph that shows it. */
  async attach(noteId: string, rng: Rng): Promise<void> {
    const bytes = new TextEncoder().encode(`picture ${rng.int(5)}`);
    const { path } = await this.ops.keepAttachment(bytes, 'png');
    const doc = this.replica.note(noteId)!;
    doc.transact(() => {
      const p = new Y.Node('paragraph');
      doc.get(NOTE_ROOT).insert(0, [p]);
      const image = new Y.Node('image');
      p.insert(0, [image]);
      image.setAttr('src', path);
      image.setAttr('alt', 'a picture');
      image.setAttr('title', null);
      image.setAttr('width', null);
    });
  }

  async sync(options: SyncOptions = {}): Promise<SyncReport> {
    const report = await this.engine.sync(options);
    this.world.stats.syncs++;
    this.world.stats.commits += report.commit ? 1 : 0;
    this.world.stats.rejected += report.attempts - 1;
    if (report.newWriter) this.events.push({ type: 'new-writer', writer: report.newWriter });
    this.world.lastSync.set(this.name, report);
    await this.world.checkRender(this, report);
    return report;
  }
}

export interface RunOptions {
  readonly steps?: number;
  /** A directory target inside a code repository, with a colleague pushing code. */
  readonly dir?: string;
  /**
   * A deliberate bug in what one clone commits (the checks have teeth, as G0 showed): it drops
   * the changes `drop` picks from every commit of clone `clone`.
   */
  readonly mutate?: {
    readonly clone: string;
    readonly drop: (path: string, bytes: Uint8Array | null) => boolean;
  };
  /** A deliberate bug in one clone's engine (`EngineOptions.mutation`). */
  readonly bug?: { readonly clone: string; readonly mutation: 'no-claims' | 'narrow-render' };
}

export interface RunSummary {
  readonly seed: number;
  readonly commits: number;
  readonly rejected: number;
  readonly syncs: number;
  readonly notes: number;
  readonly renames: { title: number; folder: number; foreign: number };
  readonly crashes: number;
  readonly lostPushes: number;
  readonly rollbacks: number;
  readonly purges: number;
  readonly copies: number;
  readonly newWriters: number;
  readonly colleague: number;
  readonly handEdits: number;
}

class World {
  time = Date.UTC(2026, 9, 29, 14, 0, 0);
  readonly clock = () => this.time;
  readonly stats = {
    syncs: 0,
    commits: 0,
    rejected: 0,
    crashes: 0,
    lostPushes: 0,
    rollbacks: 0,
    purges: 0,
    copies: 0,
    colleague: 0,
    handEdits: 0,
  };
  readonly lastSync = new Map<string, SyncReport>();
  readonly remote = new MemoryRemote();
  readonly branch = 'main';
  readonly layout: Layout;

  constructor(
    readonly rng: Rng,
    readonly root: string,
    private readonly mutate?: RunOptions['mutate'],
    readonly bug?: RunOptions['bug'],
  ) {
    this.layout = new Layout(root);
  }

  transport(name: string): MemoryTransport {
    if (this.mutate?.clone === name) {
      const drop = this.mutate.drop;
      return new (class extends MemoryTransport {
        override commit(
          head: string | null,
          changes: ReadonlyMap<string, Uint8Array | null>,
          message: string,
        ) {
          const kept = new Map([...changes].filter(([path, bytes]) => !drop(path, bytes)));
          return super.commit(head, kept, message);
        }
      })({
        remote: this.remote,
        branch: this.branch,
        root: this.root,
        author: { name: `Penmoss ${name}`, email: `${name.toLowerCase()}@example.invalid` },
        clock: this.clock,
      });
    }
    return new MemoryTransport({
      remote: this.remote,
      branch: this.branch,
      root: this.root,
      author: { name: `Penmoss ${name}`, email: `${name.toLowerCase()}@example.invalid` },
      clock: this.clock,
    });
  }

  /** After a sync: the clone's full render equals what the head holds, byte for byte. */
  async checkRender(clone: Clone, report: SyncReport): Promise<void> {
    if (!report.head) return;
    const { wanted, penmoss } = await clone.engine.renderAll(report.head);
    for (const [path, markdown] of wanted) {
      const bytes = this.remote.read(report.head, path);
      if (!bytes) fail(`${clone.name}: ${path} is not at head`);
      if (new TextDecoder().decode(bytes!) !== markdown) {
        fail(
          `${clone.name}: ${path} at head differs from its own full render (the render set missed it)`,
        );
      }
    }
    for (const path of penmoss.keys())
      if (!wanted.has(path)) fail(`${clone.name}: stale Penmoss file ${path}`);
  }
}

/** One random run; throws `CheckError` (or anything the engine threw) when a check fails. */
export async function runOnce(seed: number, options: RunOptions = {}): Promise<RunSummary> {
  const rng = rngFrom(seed);
  const steps = options.steps ?? 60;
  const root = options.dir ? `${options.dir}/` : '';
  const world = new World(rng, root, options.mutate, options.bug);
  const tick = () => (world.time += 1000 + rng.int(60_000));

  // A code repository's colleague: code at the top, a hand-written README in the directory.
  const colleague = { files: new Map<string, string>(), handMade: null as string | null };
  if (options.dir) {
    await world.remote.commitAs(
      world.branch,
      {
        'README.md': '# A code repository\n',
        'src/app.js': 'export const answer = 42;\n',
        [`${root}README.md`]: '# Team notes\n\nWritten by hand; Penmoss must leave it alone.\n',
      },
      'Initial code',
    );
  }
  const colleagueCommit = async () => {
    const head = world.remote.branches.get(world.branch)!;
    const file = `src/file-${world.stats.colleague}.js`;
    const body = `export const n = ${world.stats.colleague};\n`;
    const files: Record<string, string> = { [file]: body };
    if (rng.chance(0.3))
      files['README.md'] = `# A code repository\n\nEdit ${world.stats.colleague}\n`;
    if (rng.chance(0.3)) {
      // A hand edit to a rendered note: overwritten by the next render (A823, G0's change 3).
      const rendered = [...world.remote.commits.get(head)!.tree.keys()].filter(
        (path) =>
          path.startsWith(root) &&
          path.endsWith('.md') &&
          !path.endsWith('README.md') &&
          path !== colleague.handMade &&
          !path.startsWith(world.layout.base),
      );
      if (rendered.length > 0) {
        const path = rng.pick(rendered);
        files[path] =
          `${new TextDecoder().decode(world.remote.read(head, path)!)}\nA line added by hand.\n`;
        world.stats.handEdits++;
      }
    }
    if (rng.chance(0.15) && !colleague.handMade) {
      // A hand-made note named like one of Penmoss's: left alone; Penmoss's own moves aside (A217).
      colleague.handMade = `${root}Ideas.md`;
      files[colleague.handMade] = '# Ideas\n\nA note written by hand, no frontmatter.\n';
    }
    await world.remote.commitAs(world.branch, files, `Code change ${world.stats.colleague}`);
    colleague.files.set(file, body);
    world.stats.colleague++;
  };

  const make = async (name: string, kind: WriterKind, create?: { id: string; name: string }) =>
    new Clone(
      name,
      kind,
      new MemoryStorage(),
      new MemorySecrets(),
      world.transport(name),
      world,
    ).open(create);
  const A = await make('A', 'device', { id: ulidAt(world.time, rng), name: 'Work' });
  const clones: Clone[] = [A];
  const purgedNotes = new Set<string>();
  const special = {
    daily: null as string | null,
    sameTitle: [] as string[],
    pinned: new Set<string>(),
  };

  const work = A.ops.createFolder({ name: 'Work', parentId: null });
  const projects = A.ops.createFolder({ name: 'Projects', parentId: work });
  A.ops.createNote({
    title: 'Meeting',
    folderId: projects,
    markdown: 'First agenda item\n\nSecond item',
  });
  A.ops.createNote({ title: 'Ideas', folderId: work, markdown: 'One idea' });
  await A.sync();
  clones.push(await make('B', 'device'), await make('C', 'agent'));
  await clones[1]!.sync();
  await clones[2]!.sync();

  const syncOf = (clone: Clone, hooks: SyncOptions = {}) => clone.sync(hooks);
  const restart = async (clone: Clone, storage: MemoryStorage) => {
    const fresh = new Clone(clone.name, clone.kind, storage, clone.secrets, clone.transport, world);
    await fresh.open();
    fresh.events.push(...clone.events);
    clones[clones.indexOf(clone)] = fresh;
    return fresh;
  };
  const live = (c: Clone) => c.liveNotes();

  const scenarios: Record<string, () => Promise<void>> = {
    sameDaily() {
      // The same daily note made offline on two clones (A4, A76): one template body.
      const [x, y] = [clones[0]!, clones[1]!];
      special.daily = x.ops.daily({ date: '2026-10-29', create: true }).id;
      y.ops.daily({ date: '2026-10-29', create: true });
      x.editBody(special.daily, rng);
      return Promise.resolve();
    },
    renames() {
      // A note renamed on one clone while its folder is renamed on another (and a third).
      const [x, y] = [clones[0]!, clones[1]!];
      const note = live(x).find(
        (id) =>
          readWorkspace(x.replica.workspace).notes.find((n) => n.id === id)?.folderId === projects,
      );
      if (!note || !y.replica.note(note)) return Promise.resolve();
      setTitle(x.replica.note(note)!, `${readTitle(x.replica.note(note)!)} renamed`);
      try {
        y.ops.renameFolder(projects, 'Projects 2026');
        if (rng.chance(0.5)) clones[2]!.ops.renameFolder(projects, 'Projects archive');
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
      }
      return Promise.resolve();
    },
    async sameTitle() {
      // Two notes titled "Standup" made offline on two clones, whose commits race.
      const a = clones[0]!.ops.createNote({ title: 'Standup', markdown: 'from A' });
      const b = clones[1]!.ops.createNote({ title: 'Standup', markdown: 'from B' });
      special.sameTitle.push(a, b);
      special.pinned.add(a).add(b);
      if (rng.chance(0.5)) {
        let once = true;
        await syncOf(clones[1]!, {
          beforePush: async () => {
            if (!once) return;
            once = false;
            await syncOf(clones[0]!);
          },
        });
      }
    },
    purgeWhileHeld() {
      // Delete for good on one clone while another holds the note and edits it offline.
      const [x, y] = [clones[0]!, clones[1]!];
      const note = live(x).find(
        (id) => y.replica.note(id) && !special.pinned.has(id) && id !== special.daily,
      );
      if (!note) return Promise.resolve();
      if (!isDeleted(y.replica.note(note)!)) y.editBody(note, rng, 3);
      x.ops.purge(note);
      purgedNotes.add(note);
      world.stats.purges++;
      return Promise.resolve();
    },
    async crash() {
      // A crash between commit and push: the next sync recomputes the same difference.
      const x = rng.pick(clones);
      if (live(x).length > 0) x.editBody(rng.pick(live(x)), rng);
      await x.engine.save();
      const before = x.storage.copy();
      try {
        await syncOf(x, {
          beforePush: () => {
            throw new Crash();
          },
        });
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        world.stats.crashes++;
        // The process died: what it saved before the sync (or during it) is all that is left.
        await restart(x, rng.chance(0.5) ? before : x.storage);
      }
    },
    async lostPush() {
      // The push landed but the app died before it recorded the new head.
      const x = rng.pick(clones);
      if (live(x).length > 0) x.editBody(rng.pick(live(x)), rng);
      await x.engine.save();
      const before = x.storage.copy();
      // What the disk holds when the process dies: the engine saves before it pushes.
      let atDeath: MemoryStorage | null = null;
      try {
        await syncOf(x, {
          afterPush: () => {
            atDeath = x.storage.copy();
            throw new Crash();
          },
        });
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        world.stats.lostPushes++;
        // Or the disk is rolled back past it (a restored snapshot): the same writer, behind what
        // it pushed, and it may edit before its next sync.
        const fresh = await restart(x, rng.chance(0.5) ? atDeath! : before);
        if (live(fresh).length > 0 && rng.chance(0.5)) fresh.editBody(rng.pick(live(fresh)), rng);
      }
    },
    async rollback() {
      // A VM snapshot rollback, Time Machine, a copied ~/.penmoss: the same writer and secret,
      // files from before its last push, and an edit before it syncs (the CLI writes first).
      const x = rng.pick(clones);
      await x.engine.save();
      const snapshot = x.storage.copy();
      if (live(x).length > 0) x.editBody(rng.pick(live(x)), rng);
      await syncOf(x);
      world.stats.rollbacks++;
      const fresh = await restart(x, snapshot);
      if (live(fresh).length > 0) fresh.editBody(rng.pick(live(fresh)), rng);
    },
    async copyProfile() {
      // A restored backup or a cloned data folder elsewhere: same data, no secret, a new writer.
      const source = clones[0]!;
      await source.engine.save();
      const copy = await new Clone(
        'D',
        'device',
        source.storage.copy(),
        new MemorySecrets(),
        world.transport('D'),
        world,
      ).open();
      for (const id of source.transport.known) copy.transport.known.add(id);
      clones.push(copy);
      world.stats.copies++;
      if (live(copy).length > 0) copy.editBody(rng.pick(live(copy)), rng);
    },
  };
  const placed = new Map<number, string[]>();
  for (const name of Object.keys(scenarios)) {
    const at = rng.int(steps);
    placed.set(at, [...(placed.get(at) ?? []), name]);
  }

  for (let step = 0; step < steps; step++) {
    tick();
    for (const name of placed.get(step) ?? []) await scenarios[name]!();
    const c = rng.pick(clones);
    const notes = live(c).filter((id) => !special.pinned.has(id));
    const folders = c.folders();
    const roll = rng();
    try {
      if (roll < 0.28 && notes.length > 0) c.editBody(rng.pick(notes), rng, 1 + rng.int(4));
      else if (roll < 0.36) {
        c.ops.createNote({
          title: title(rng),
          folderId: folders.length > 0 && rng.chance(0.7) ? rng.pick(folders) : null,
          markdown: `${rng.pick(WORDS)} start`,
        });
      } else if (roll < 0.42 && notes.length > 0)
        setTitle(c.replica.note(rng.pick(notes))!, title(rng));
      else if (roll < 0.45)
        c.ops.createFolder({
          name: title(rng),
          parentId: folders.length > 0 && rng.chance(0.5) ? rng.pick(folders) : null,
        });
      else if (roll < 0.49 && folders.length > 0) c.ops.renameFolder(rng.pick(folders), title(rng));
      else if (roll < 0.53 && notes.length > 0)
        c.ops.move(
          rng.pick(notes),
          folders.length > 0 && rng.chance(0.8) ? rng.pick(folders) : null,
        );
      else if (roll < 0.55 && folders.length > 1)
        c.ops.moveFolder(rng.pick(folders), rng.chance(0.3) ? null : rng.pick(folders));
      else if (roll < 0.57 && notes.length > 0) c.ops.trash(rng.pick(notes));
      else if (roll < 0.58) {
        const trashed = c.replica.noteIds().filter((id) => isDeleted(c.replica.note(id)!));
        if (trashed.length > 0) c.ops.restore(rng.pick(trashed));
      } else if (roll < 0.59 && folders.length > 2) c.ops.deleteFolder(rng.pick(folders));
      else if (roll < 0.6) {
        const gone = readFolderTrash(c.replica.workspace, world.time);
        if (gone.length > 0) c.ops.restoreFolder(rng.pick(gone).id);
      } else if (roll < 0.62 && notes.length > 0) {
        setFrontmatterTag(
          c.replica.note(rng.pick(notes))!,
          rng.pick(['work', 'projects/garden', 'todo']),
          rng.chance(0.7),
        );
      } else if (roll < 0.63 && notes.length > 0) await c.attach(rng.pick(notes), rng);
      else if (roll < 0.64 && notes.length > 2 && c.kind === 'device') {
        const id = rng.pick(notes);
        if (id !== special.daily) {
          c.ops.purge(id);
          purgedNotes.add(id);
          world.stats.purges++;
        }
      } else if (roll < 0.86) await syncOf(c);
      else if (roll < 0.94) {
        // Interleaved: another clone syncs between this one's commit and its push.
        const d = rng.pick(clones.filter((x) => x !== c));
        let once = true;
        await syncOf(c, {
          beforePush: async () => {
            if (!once) return;
            once = false;
            if (live(d).length > 0) d.editBody(rng.pick(live(d)), rng);
            await syncOf(d);
          },
        });
      } else if (options.dir) await colleagueCommit();
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
    }
  }

  // Everyone comes online: sync until a whole round commits nothing.
  const settle = async () => {
    for (let round = 1; ; round++) {
      if (options.dir && round === 1) await colleagueCommit();
      let commits = 0;
      for (const c of clones) if ((await syncOf(c)).commit) commits++;
      if (commits === 0) return;
      if (round > 8) fail(`no fixed point after ${round} rounds (ping-pong)`);
    }
  };
  await settle();
  // Free the plain name: its holder is retitled. The other keeps its stored name (assigned once).
  let freed: string | null = null;
  if (special.sameTitle.length === 2) {
    const x = clones[0]!;
    const holder = special.sameTitle.find((id) => {
      const node: unknown = x.replica.workspace.get('notes').getAttr(id);
      return (
        node instanceof Y.Node &&
        (node.getAttr(NOTE_NAME_ATTR) as { name?: string } | undefined)?.name === 'Standup'
      );
    });
    if (holder && x.replica.note(holder)) {
      setTitle(x.replica.note(holder)!, 'Standup moved');
      freed = special.sameTitle.find((id) => id !== holder) ?? null;
      await settle();
    }
  }

  checkConverged(clones);
  const history = checkHistory(world);
  for (const id of purgedNotes) {
    for (const c of clones) if (c.replica.note(id)) fail(`${c.name} still holds purged ${id}`);
  }
  if (special.daily) {
    const doc = clones[0]!.replica.note(special.daily);
    if (doc) {
      const copies = bodyMarkdown(doc).split('## Plan').length - 1;
      if (copies !== 1) fail(`the daily note holds its template ${copies} times`);
    }
  }
  if (special.sameTitle.length === 2) {
    const names = clones[0]!.replica.workspace.get('notes');
    const nameOf = (id: string) => {
      const node: unknown = names.getAttr(id);
      return node instanceof Y.Node
        ? (node.getAttr(NOTE_NAME_ATTR) as { name?: string } | undefined)?.name
        : undefined;
    };
    const [a, b] = [...special.sameTitle].sort() as [string, string];
    const na = nameOf(a);
    const nb = nameOf(b);
    if (na !== undefined && nb !== undefined) {
      if (nameKey(na) === nameKey(nb)) fail(`same-title notes share a name: ${na}`);
      if (freed && nameOf(freed) === 'Standup')
        fail('a stored name moved when the plain name was freed');
    }
  }
  if (options.dir) {
    const head = world.remote.branches.get(world.branch)!;
    for (const [file, body] of colleague.files) {
      const bytes = world.remote.read(head, file);
      if (!bytes || new TextDecoder().decode(bytes) !== body)
        fail(`the colleague's ${file} changed`);
    }
    if (
      colleague.handMade &&
      !new TextDecoder()
        .decode(world.remote.read(head, colleague.handMade)!)
        .includes('written by hand')
    ) {
      fail('the hand-made note in the directory changed');
    }
    if (
      !new TextDecoder()
        .decode(world.remote.read(head, `${root}README.md`)!)
        .includes('Written by hand')
    ) {
      fail('the hand-made README in the directory changed');
    }
  }
  return {
    seed,
    commits: world.stats.commits,
    rejected: world.stats.rejected,
    syncs: world.stats.syncs,
    notes: clones[0]!.replica.noteIds().length,
    renames: history.renames,
    crashes: world.stats.crashes,
    lostPushes: world.stats.lostPushes,
    rollbacks: world.stats.rollbacks,
    purges: world.stats.purges,
    copies: world.stats.copies,
    newWriters: clones.flatMap((c) => c.events.filter((e) => e.type === 'new-writer')).length,
    colleague: world.stats.colleague,
    handEdits: world.stats.handEdits,
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

function workspaceContent(doc: Y.Doc): string {
  const snapshot = readWorkspace(doc);
  const node = (name: string) =>
    Object.fromEntries(
      [...doc.get(name).attrEntries()]
        .map(([k, v]) => [String(k), v instanceof Y.Node ? v.getAttrs() : v] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : 1);
  return canonical({
    folders: [...snapshot.folders].sort(byId),
    notes: [...snapshot.notes].sort(byId),
    folderNodes: node('folders'),
    noteNodes: node('notes'),
    purged: node(WORKSPACE_PURGED),
    settings: node('settings'),
  });
}

function noteContent(doc: Y.Doc): string {
  return canonical({
    title: readTitle(doc),
    meta: doc.get('meta').getAttrs() as Record<string, unknown>,
    body: noteBody(doc).toJSON() as unknown,
  });
}

function sameStateVector(a: Y.Doc, b: Y.Doc): boolean {
  const x = Y.decodeStateVector(Y.encodeStateVector(a));
  const y = Y.decodeStateVector(Y.encodeStateVector(b));
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

/** Every clone: the same head, the same WorkspaceDoc and note docs (content, ids, state vectors). */
export function checkConverged(clones: readonly Clone[]): void {
  const [first, ...rest] = clones as [Clone, ...Clone[]];
  const heads = clones.map((c) => c.replica.state.lastHead);
  if (new Set(heads).size !== 1) fail(`clones end on different heads: ${heads.join(' ')}`);
  const ws = workspaceContent(first.replica.workspace);
  const ids = first.replica.noteIds();
  for (const c of rest) {
    if (workspaceContent(c.replica.workspace) !== ws)
      fail(`${c.name}'s WorkspaceDoc differs from ${first.name}'s`);
    if (!sameContent(c.replica.workspace, first.replica.workspace))
      fail(`${c.name}'s WorkspaceDoc ids differ`);
    if (!sameStateVector(c.replica.workspace, first.replica.workspace))
      fail(`${c.name}'s WorkspaceDoc state vector differs`);
    const theirs = c.replica.noteIds();
    if (theirs.join() !== ids.join())
      fail(`${c.name} holds ${theirs.length} notes, ${first.name} ${ids.length}`);
    for (const id of ids) {
      const a = first.replica.note(id)!;
      const b = c.replica.note(id)!;
      if (noteContent(a) !== noteContent(b))
        fail(`note ${id} differs between ${first.name} and ${c.name}`);
      if (!sameContent(a, b) || !sameStateVector(a, b))
        fail(`note ${id}'s ids differ between ${first.name} and ${c.name}`);
    }
  }
}

/**
 * The branch's history: Penmoss commits say so and touch only `<dir>`; a note's file moves only
 * for its title, its folder, or a hand-made file taking the name (never for a concurrent claim:
 * claims ride only in landed commits); a purged note never has logs or a file after its purge.
 */
export function checkHistory(world: World) {
  const commits = world.remote.history(world.branch);
  const root = world.root;
  const renames = { title: 0, folder: 0, foreign: 0 };
  const decoder = new TextDecoder();
  let previous: Map<string, { path: string; name: string; dir: string; base: string }> | null =
    null;
  // Where each Delete for good landed: the first commit whose WorkspaceDoc logs hold it.
  const purgeIndex = new Map<string, number>();
  for (const [i, commit] of commits.entries()) {
    const logs = [...commit.tree].filter(
      ([path]) => world.layout.parse(path)?.kind === 'workspace',
    );
    if (logs.length === 0) continue;
    const doc = new Y.Doc();
    for (const [, blob] of logs) Y.applyUpdate(doc, world.remote.blobs.get(blob)!);
    for (const id of doc.get(WORKSPACE_PURGED).attrKeys()) {
      if (!purgeIndex.has(String(id))) purgeIndex.set(String(id), i);
    }
    doc.destroy();
  }
  for (const [i, commit] of commits.entries()) {
    const isPenmoss = commit.author.name.startsWith('Penmoss ');
    if (isPenmoss) {
      if (
        !/^Penmoss: \d+ notes? \[skip ci\]\n\nPenmoss-Writer: [0-9A-Z]{26} \((device|agent) "[^"\n]*"\)\n?$/.test(
          commit.message,
        )
      )
        fail(`commit message: ${commit.message}`);
      const before = i > 0 ? commits[i - 1]!.tree : new Map<string, string>();
      for (const path of new Set([...before.keys(), ...commit.tree.keys()])) {
        if (before.get(path) !== commit.tree.get(path) && !path.startsWith(root)) {
          fail(`Penmoss commit ${commit.id} changed ${path}, outside ${root || '/'}`);
        }
      }
    }
    const notes = new Map<string, { path: string; name: string; dir: string; base: string }>();
    const foreignKeys = new Set<string>();
    for (const [path, blob] of commit.tree) {
      if (!path.startsWith(root) || !path.endsWith('.md') || path.startsWith(`${root}.penmoss/`))
        continue;
      const text = decoder.decode(world.remote.blobs.get(blob));
      const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
      const meta = match ? readNoteMeta(parseFrontmatter(match[1]!)) : {};
      const name = path.slice(path.lastIndexOf('/') + 1, -3);
      if (!meta.id) {
        foreignKeys.add(nameKey(name));
        continue;
      }
      notes.set(meta.id, {
        path,
        name,
        dir: path.slice(0, path.lastIndexOf('/') + 1),
        base: noteName(meta.title ?? ''),
      });
    }
    for (const [id, at] of purgeIndex) {
      if (i < at) continue;
      for (const path of commit.tree.keys()) {
        if (path.startsWith(`${root}.penmoss/notes/${id}/`))
          fail(`purged note ${id} has logs again at ${commit.id}`);
      }
      if (notes.has(id)) fail(`purged note ${id} has a file again at ${commit.id}`);
    }
    if (previous) {
      for (const [id, now] of notes) {
        const before = previous.get(id);
        if (!before || before.path === now.path) continue;
        if (before.base !== now.base) renames.title++;
        else if (before.dir !== now.dir) renames.folder++;
        else if (foreignKeys.has(nameKey(before.name))) renames.foreign++;
        else {
          const holder = [...notes].find(
            ([other, n]) => other !== id && nameKey(n.name) === nameKey(before.name),
          );
          fail(
            holder
              ? `note ${id} lost its committed name ${before.name} to ${holder[0]} at ${commit.id}`
              : `note ${id} renamed ${before.path} → ${now.path} at ${commit.id} with no cause`,
          );
        }
      }
    }
    previous = notes;
  }
  return { renames, commits: commits.length };
}
