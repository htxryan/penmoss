// The git notebook format and engine as #147 specifies them (A741 format, A742 sync, A743
// render), over today's Penmoss code (lib/penmoss.mjs). One `Clone` is one writer: one install
// of one notebook, holding what the app's IndexedDB holds (the merged WorkspaceDoc and note
// docs) plus a git clone it can throw away.
import { createHash, randomBytes } from 'node:crypto';
import { P } from './penmoss.mjs';

const { Y } = P;

export const FORMAT = 1;
export const RENDER_VERSION = 1;
/** "At most 3 times" (A742): the first attempt and three rebuilds. */
export const MAX_ATTEMPTS = 4;
export const PURGED = 'purged';
/** A note's stored file name (A743): `{ base, name }`, one JSON value so a claim is atomic. */
export const NOTE_NAME_ATTR = 'fileName';
/** A folder's stored directory name (A212's FolderName), one JSON value. */
export const FOLDER_NAME_ATTR = 'dirName';
/**
 * Where name claims are written (A743). `commit` (the spike's suggestion): in a fork of the
 * WorkspaceDoc that reaches the local doc only once its commit lands, so a rejected or crashed
 * attempt leaves no claim behind. `local` (#147 as written): straight into the local doc.
 */
export const CLAIMS = process.env.SPIKE_CLAIMS ?? 'commit';
/**
 * Deliberate bugs, to show the checks catch them (`SPIKE_MUTATE=<name>`): `purge` (logs of
 * purged notes still applied), `own-at-head` (own file drops what it had), `render-clock`
 * (render reads the wall clock), `render-set` (only this device's edits re-render),
 * `no-claims` (stored names ignored).
 */
export const MUTATE = process.env.SPIKE_MUTATE ?? '';
/**
 * How a writer's own file is recomputed (A741). `ids` (the spike's): the content ids the local
 * doc has and no file at head has, inserts and deletes alike. `spec` (#147 as written):
 * `encodeStateAsUpdate(local, stateVector(head))`, which always carries the full delete set.
 */
export const OWN_FILE = process.env.SPIKE_OWNFILE ?? 'ids';
export const DAILY_TEMPLATE = '## {{longDate}}\n\n- [ ] Plan the day\n\nNotes for {{weekday}}.';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------------------------
// Repository layout (A741)

export function layout(root) {
  const base = `${root}.penmoss/`;
  return {
    base,
    notebook: `${base}notebook.json`,
    actor: (writer) => `${base}actors/${writer}.json`,
    workspace: (writer) => `${base}workspace/${writer}.yjs`,
    note: (noteId, writer) => `${base}notes/${noteId}/${writer}.yjs`,
    noteDir: (noteId) => `${base}notes/${noteId}/`,
    parse(path) {
      if (!path.startsWith(base)) return null;
      const rest = path.slice(base.length).split('/');
      if (rest[0] === 'actors' && rest.length === 2) return { kind: 'actor', writer: rest[1].replace(/\.json$/, '') };
      if (rest[0] === 'workspace' && rest.length === 2 && rest[1].endsWith('.yjs')) {
        return { kind: 'workspace', writer: rest[1].slice(0, -4) };
      }
      if (rest[0] === 'notes' && rest.length === 3 && rest[2].endsWith('.yjs')) {
        return { kind: 'note', noteId: rest[1], writer: rest[2].slice(0, -4) };
      }
      if (rest[0] === 'notebook.json') return { kind: 'notebook' };
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness (so a failing run can be replayed with --seed)

export function rngFrom(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (list) => list[Math.floor(next() * list.length)];
  next.chance = (p) => next() < p;
  return next;
}

const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulidAt(time, rng) {
  let out = '';
  for (let rest = time, i = 0; i < 10; i++) {
    out = ULID[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  for (let i = 0; i < 16; i++) out += ULID[rng ? rng.int(32) : randomBytes(1)[0] % 32];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Yjs helpers

/** A doc whose client id comes from the run's randomness (Yjs ids are 31-bit, never 0). */
export function newDoc(rng) {
  const doc = new Y.Doc();
  if (rng) doc.clientID = (Math.floor(rng() * 0x7fffffff) || 1) >>> 0;
  return doc;
}

/** A copy of a doc under a fresh client id: changes to it reach `doc` only if applied. */
function forkDoc(doc, rng) {
  const fork = newDoc(rng);
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
  return fork;
}

const isEmptyIds = (ids) => ids.inserts.isEmpty() && ids.deletes.isEmpty();

/**
 * A741's own file: own at head plus what the local doc has that no file at head has. The
 * difference is taken over content ids (inserts and deletes), so a delete another writer
 * already logged is not copied into this writer's file. Returns null when nothing is missing.
 */
export function ownFile(localUpdate, headParts, ownAtHead) {
  if (OWN_FILE === 'spec') {
    // #147 as written: everything past the head's state vector, with the full delete set.
    const sv = headParts.length > 0 ? Y.encodeStateVectorFromUpdate(Y.mergeUpdates(headParts)) : undefined;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, localUpdate);
    const delta = Y.encodeStateAsUpdate(doc, sv);
    doc.destroy();
    const next = ownAtHead ? Y.mergeUpdates([ownAtHead, delta]) : delta;
    return ownAtHead && sameBytes(next, ownAtHead) ? null : next;
  }
  const local = Y.createContentIdsFromUpdate(localUpdate);
  const missing =
    headParts.length > 0
      ? Y.excludeContentIds(local, Y.createContentIdsFromUpdate(Y.mergeUpdates(headParts)))
      : local;
  if (isEmptyIds(missing)) return null;
  const delta = Y.intersectUpdateWithContentIds(localUpdate, missing);
  if (MUTATE === 'own-at-head') return delta;
  return ownAtHead ? Y.mergeUpdates([ownAtHead, delta]) : delta;
}

/** Content of a note as compared across clones: title, meta and body (JSON), sorted keys. */
export function noteContent(doc) {
  const meta = doc.get('meta').getAttrs();
  return canonical({
    title: P.readTitle(doc),
    meta: Object.fromEntries(Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : 1))),
    body: P.noteBody(doc).toJSON(),
  });
}

/** JSON with every object's keys sorted: attribute order is insertion order, not content. */
export function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export function workspaceContent(doc) {
  const snap = P.readWorkspace(doc);
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  const node = (name) =>
    Object.fromEntries(
      [...doc.get(name).attrEntries()]
        .map(([k, v]) => [String(k), v instanceof Y.Node ? v.getAttrs() : v])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  return canonical({
    folders: [...snap.folders].sort(byId),
    notes: [...snap.notes].sort(byId),
    folderNames: node('folders'),
    noteNames: node('notes'),
    purged: node(PURGED),
  });
}

/** Content ids of a doc (inserts with deletes, and deletes): equal on converged replicas. */
export function contentIdsEqual(a, b) {
  const x = Y.createContentIdsFromDoc(a, true);
  const y = Y.createContentIdsFromDoc(b, true);
  return Y.equalIdSets(x.inserts, y.inserts) && Y.equalIdSets(x.deletes, y.deletes);
}

const sameBytes = (a, b) => a !== null && b !== null && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---------------------------------------------------------------------------------------------
// Render (A743): a pure function of the merged docs, the WorkspaceDoc's stored names, foreign
// file names and the render version.

function storedJson(node, attr) {
  const value = node?.getAttr(attr);
  return value && typeof value === 'object' ? value : null;
}

const FRONTMATTER_ID = /^---\nid: ([0-9A-Z]{26})\n/;
export function frontmatterId(bytes) {
  if (!bytes) return null;
  const head = dec.decode(bytes.subarray(0, 64));
  return FRONTMATTER_ID.exec(head)?.[1] ?? null;
}

/** The wikilink and embed targets a body names (by note id). */
function linkTargets(doc) {
  const out = new Set();
  const walk = (node) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.Node)) continue;
      if (child.name === 'wikilink' || child.name === 'embed') {
        const id = child.getAttr('noteId');
        if (typeof id === 'string') out.add(id);
      } else walk(child);
    }
  };
  walk(doc.get(P.NOTE_ROOT));
  return out;
}

/** `updated` (A743): the latest of the per-writer keys, never one shared key. */
export function changedAtOf(doc) {
  let max = 0;
  for (const [key, value] of Object.entries(doc.get('meta').getAttrs())) {
    if (key.startsWith('changedAt/') && typeof value === 'number' && value > max) max = value;
  }
  return max;
}

/**
 * Names and paths for every note and folder. Notes keep a stored claim while their title's
 * base is unchanged and no older note (or a foreign file) holds the name; everything else is
 * named afresh, in id order, so the older id wins a clash between concurrent claims.
 */
export function assignNames({ workspace, notes, purged, foreign, root }) {
  const snap = P.readWorkspace(workspace);
  const parents = P.effectiveParents(snap.folders);
  const folderNodes = workspace.get('folders');
  const mirrorFolders = snap.folders.map((f) => ({ id: f.id, name: f.name, parentId: parents.get(f.id) ?? null }));
  const previous = new Map();
  for (const f of snap.folders) {
    const stored = storedJson(folderNodes.getAttr(f.id), FOLDER_NAME_ATTR);
    if (stored) previous.set(f.id, stored);
  }
  const assigned = P.assignFolders(mirrorFolders, previous, (dir, key) => foreign.reserved.has(`${dir}\0${key}`));
  const dirs = P.folderDirs(mirrorFolders, assigned);

  const registryNodes = workspace.get('notes');
  const entries = snap.notes
    .filter((entry) => notes.has(entry.id) && !purged.has(entry.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const taken = new Set(foreign.noteKeys);
  const names = new Map();
  const later = [];
  for (const entry of entries) {
    const base = P.noteName(P.readTitle(notes.get(entry.id)));
    const stored = storedJson(registryNodes.getAttr(entry.id), NOTE_NAME_ATTR);
    const key = stored ? P.nameKey(stored.name) : null;
    if (stored && stored.base === base && !taken.has(key) && MUTATE !== 'no-claims') {
      taken.add(key);
      names.set(entry.id, { base, name: stored.name });
    } else later.push([entry, base]);
  }
  for (const [entry, base] of later) {
    const name = P.uniqueName(base, entry.id, (key) => taken.has(key));
    taken.add(P.nameKey(name));
    names.set(entry.id, { base, name });
  }
  const paths = new Map();
  for (const entry of entries) {
    const doc = notes.get(entry.id);
    if (P.isDeleted(doc)) continue;
    const dir = entry.folderId === null ? '' : (dirs.get(entry.folderId) ?? '');
    paths.set(entry.id, `${root}${P.notePath(dir, names.get(entry.id).name)}`);
  }
  return { assigned, dirs, names, paths, entries };
}

/** One note's markdown, as the mirror writes it (A204, A205). */
export function renderOne(doc, noteId, path, names, paths, root) {
  const links = {
    resolve: () => null,
    linkText: (id) => (paths.has(id) ? names.get(id).name : null),
    title: (id) => (paths.has(id) ? names.get(id).title : null),
  };
  const prefix = P.assetPrefix(path.slice(root.length));
  const assetUrl = (url) => {
    const file = P.localAttachment(url);
    return file ? `${prefix}attachments/${file.sha256}.${file.ext}` : url;
  };
  const changedAt = MUTATE === 'render-clock' ? Date.now() : changedAtOf(doc);
  return P.renderNote(P.readNoteState(doc), noteId, changedAt, { links, assetUrl }).markdown;
}

/** What the head holds under the directory that Penmoss did not write (A217). */
export function foreignOf(files, readHead, root, knownIds) {
  const reserved = new Set();
  const noteKeys = new Set();
  const penmoss = new Map();
  const paths = [];
  for (const path of files.keys()) {
    if (!path.startsWith(root)) continue;
    const rel = path.slice(root.length);
    if (rel.startsWith('.penmoss/') || rel.startsWith('attachments/')) continue;
    if (rel.endsWith('.md')) {
      const id = frontmatterId(readHead(path));
      if (id && knownIds.has(id)) {
        penmoss.set(path, id);
        continue;
      }
    }
    paths.push(rel);
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) reserved.add(`${parts.slice(0, i).join('/')}\0${P.nameKey(parts[i])}`);
    const last = parts.at(-1);
    if (last.endsWith('.md')) noteKeys.add(P.nameKey(last.slice(0, -3)));
  }
  return { reserved, noteKeys, penmoss, paths };
}

// ---------------------------------------------------------------------------------------------
// One writer

const secretHash = (secret) => createHash('sha256').update(secret).digest('hex');

export class Clone {
  /**
   * `profile` is what the app keeps in its data folder (IndexedDB and settings); `keychain`
   * holds the writer secret, which a copied data folder does not carry (A741).
   */
  constructor({ name, kind = 'device', transport, rng, clock, profile = null, keychain = {}, log = () => {} }) {
    this.name = name;
    this.kind = kind;
    this.t = transport;
    this.rng = rng;
    this.clock = clock;
    this.keychain = keychain;
    this.log = log;
    this.L = layout(transport.root);
    this.workspace = newDoc(rng);
    this.notes = new Map();
    this.ownClients = new Set([this.workspace.clientID]);
    this.dirty = new Map();
    this.lastHead = null;
    this.stats = { syncs: 0, commits: 0, attempts: 0, gaveUp: 0, rendered: 0, renderSetMisses: 0, syncMs: 0 };
    this.events = [];
    this.pendingPurges = [];
    if (profile) this.restore(profile);
  }

  // --- the profile (what survives a restart; what a copied profile carries) ---

  /** What the app's data folder holds: every doc, the unsynced edits, the last synced head. */
  profile() {
    return {
      writer: this.writer,
      workspace: Y.encodeStateAsUpdate(this.workspace),
      notes: new Map([...this.notes].map(([id, doc]) => [id, Y.encodeStateAsUpdate(doc)])),
      dirty: new Map(this.dirty),
      ownClients: new Set(this.ownClients),
      lastHead: this.lastHead,
      pendingPurges: [...this.pendingPurges],
    };
  }

  /** A restart (or a copied profile): new docs, so new Yjs client ids, as the app gets. */
  restore(profile) {
    this.writer = profile.writer;
    this.workspace = newDoc(this.rng);
    Y.applyUpdate(this.workspace, profile.workspace);
    this.notes = new Map();
    for (const [id, update] of profile.notes) {
      const doc = newDoc(this.rng);
      Y.applyUpdate(doc, update);
      this.notes.set(id, doc);
    }
    this.dirty = new Map(profile.dirty);
    this.ownClients = new Set([...profile.ownClients, this.workspace.clientID]);
    this.lastHead = profile.lastHead;
    this.pendingPurges = [...(profile.pendingPurges ?? [])];
  }

  /** The writer id, bound to a secret in the keychain; a mismatch means a copied profile. */
  ensureWriter() {
    const secret = this.keychain.secret;
    if (this.writer && secret && this.writer.secretHash === secretHash(secret)) return;
    const previous = this.writer?.id ?? null;
    const fresh = randomBytes(16).toString('hex');
    this.keychain.secret = fresh;
    this.writer = { id: ulidAt(this.clock.now(), this.rng), secretHash: secretHash(fresh), kind: this.kind, label: this.name };
    // A new writer's own client ids are only the ones it uses from now on.
    this.ownClients = new Set([this.workspace.clientID, ...[...this.notes.values()].map((d) => d.clientID)]);
    if (previous) this.events.push({ type: 'new-writer', previous, writer: this.writer.id });
  }

  // --- what the app does locally (each edit lands in IndexedDB at once) ---

  touch(noteId) {
    const doc = this.notes.get(noteId);
    this.ownClients.add(doc.clientID);
    this.dirty.set(noteId, this.clock.now());
  }

  purgedIds() {
    return new Set([...this.workspace.get(PURGED).attrKeys()].map(String));
  }

  liveNotes() {
    const registered = new Set(P.readWorkspace(this.workspace).notes.map((n) => n.id));
    return [...this.notes.keys()].filter((id) => registered.has(id) && !P.isDeleted(this.notes.get(id))).sort();
  }

  folders() {
    return P.readWorkspace(this.workspace).folders.map((f) => f.id).sort();
  }

  createNote({ title, folderId = null, body = '', id }) {
    const now = this.clock.now();
    const noteId = id ?? ulidAt(now, this.rng);
    const doc = newDoc(this.rng);
    P.initNote(doc, { id: noteId, created: isoAt(now), kind: 'note' }, title);
    if (body) doc.get(P.NOTE_ROOT).applyDelta(P.docToDelta(P.parseMarkdown(body).doc));
    else doc.get(P.NOTE_ROOT).applyDelta(P.docToDelta(P.parseMarkdown('').doc));
    this.notes.set(noteId, doc);
    this.ownClients.add(this.workspace.clientID);
    if (folderId !== null && !this.folders().includes(folderId)) folderId = null;
    P.registerNote(this.workspace, { id: noteId, folderId });
    this.touch(noteId);
    return noteId;
  }

  /**
   * Today's daily note (A4, A76): byte-identical on every device for one template, so two
   * devices that make it offline make one note. Filed in the Journal folder, whose id is
   * derived too. (A git notebook would salt both ids with the notebook id, A740.)
   */
  createDaily(period) {
    const note = P.periodicNote(P, 'daily', period, DAILY_TEMPLATE);
    if (!this.notes.has(note.id)) {
      const doc = newDoc(this.rng);
      Y.applyUpdate(doc, note.update);
      this.notes.set(note.id, doc);
    }
    const journal = P.journalFolderId('Journal');
    if (!this.folders().includes(journal)) {
      P.createFolder(this.workspace, { id: journal, name: 'Journal', parentId: null });
    }
    P.registerNote(this.workspace, { id: note.id, folderId: journal });
    this.ownClients.add(this.workspace.clientID);
    this.touch(note.id);
    return note.id;
  }

  renameNote(noteId, title) {
    P.setTitle(this.notes.get(noteId), title);
    this.touch(noteId);
  }

  trash(noteId, deleted = true) {
    P.setDeleted(this.notes.get(noteId), deleted, null, { at: this.clock.now(), folderId: null });
    this.touch(noteId);
  }

  /** Random body edits: insert or delete text, add a paragraph (sometimes with a link), drop one. */
  editBody(noteId, rng, bursts = 1) {
    const doc = this.notes.get(noteId);
    const root = doc.get(P.NOTE_ROOT);
    const others = this.liveNotes().filter((id) => id !== noteId);
    doc.transact(() => {
      for (let i = 0; i < bursts; i++) {
        const paragraphs = root.toArray().filter((n) => n instanceof Y.Node && n.name === 'paragraph');
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
            link.setAttr('target', P.readTitle(this.notes.get(target)) || 'Untitled');
            link.setAttr('heading', null);
            link.setAttr('alias', null);
          }
        } else {
          const index = root.toArray().indexOf(rng.pick(paragraphs));
          root.delete(index, 1);
        }
      }
    });
    this.touch(noteId);
  }

  createFolder(name, parentId = null) {
    const id = ulidAt(this.clock.now(), this.rng);
    if (parentId !== null && !this.folders().includes(parentId)) parentId = null;
    P.createFolder(this.workspace, { id, name, parentId });
    return id;
  }

  renameFolder(id, name) {
    P.renameFolder(this.workspace, id, name);
  }

  moveFolder(id, parentId) {
    P.moveFolder(this.workspace, id, parentId, P.keyBetween(null, null));
  }

  moveNote(noteId, folderId) {
    P.moveNote(this.workspace, noteId, folderId, P.keyBetween(null, null));
  }

  /** Delete for good (A748): `purged` gets the id, the registry loses it, the local copy goes. */
  purge(noteId) {
    this.workspace.transact(() => {
      this.workspace.get(PURGED).setAttr(noteId, this.clock.now());
      this.workspace.get('notes').deleteAttr(noteId);
    });
    this.notes.get(noteId)?.destroy();
    this.notes.delete(noteId);
    this.dirty.delete(noteId);
    this.pendingPurges.push(noteId);
    this.events.push({ type: 'purge', noteId });
  }

  // --- sync (A742) ---

  /**
   * One sync: fetch, apply every writer's logs, recompute own files, render, commit on the
   * remote head, push fast-forward; rebuild on rejection. `hooks.beforePush(commit)` lets a
   * test run another clone's sync between commit and push, or crash there (throw).
   */
  sync(hooks = {}) {
    const started = performance.now();
    this.ensureWriter();
    this.stats.syncs++;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        this.stats.attempts++;
        const built = this.build(hooks);
        if (built.commit === null) {
          this.synced(built.head);
          return { commit: null, head: built.head, attempt };
        }
        hooks.beforePush?.(built);
        if (this.t.push(built.commit)) {
          this.stats.commits++;
          built.landed?.();
          hooks.afterPush?.(built);
          for (const noteId of this.pendingPurges) this.events.push({ type: 'purge-pushed', noteId, commit: built.commit });
          this.pendingPurges = [];
          this.synced(built.commit);
          this.events.push({ type: 'commit', commit: built.commit, notes: built.noteCount, attempt });
          return { commit: built.commit, head: built.commit, attempt, built };
        }
        this.log(`${this.name}: push rejected, rebuilding (attempt ${attempt + 1})`);
      }
      this.stats.gaveUp++;
      return { commit: null, gaveUp: true };
    } finally {
      this.stats.syncMs += performance.now() - started;
    }
  }

  synced(head) {
    this.lastHead = head;
    this.dirty.clear();
  }

  build({ fullRender = false, checkRenderSet = false } = {}) {
    const L = this.L;
    const t = this.t;
    const head = t.fetch();
    if (head) t.checkout(head);
    const files = t.list(head);
    const meta = files.has(L.notebook) ? JSON.parse(dec.decode(t.read(L.notebook))) : null;
    const changed = t.changed(this.lastHead, head, L.base) ?? [...files.keys()].filter((p) => p.startsWith(L.base));
    const read = (path) => t.read(path);

    // 1. Apply every writer's logs that changed: the WorkspaceDoc first (it carries `purged`).
    const parsedChanged = changed.map((path) => [path, L.parse(path)]).filter(([, p]) => p);
    for (const [path, p] of parsedChanged) {
      if (p.kind !== 'workspace' || !files.has(path)) continue;
      Y.applyUpdate(this.workspace, read(path), 'git');
    }
    const purged = this.purgedIds();
    for (const id of purged) {
      if (this.notes.has(id) && MUTATE !== 'purge') {
        this.notes.get(id).destroy();
        this.notes.delete(id);
        this.dirty.delete(id);
        this.events.push({ type: 'dropped-purged', noteId: id });
      }
    }
    const changedNotes = new Set();
    for (const [path, p] of parsedChanged) {
      if (p.kind !== 'note' || !files.has(path) || (purged.has(p.noteId) && MUTATE !== 'purge')) continue;
      let doc = this.notes.get(p.noteId);
      if (!doc) this.notes.set(p.noteId, (doc = newDoc(this.rng)));
      Y.applyUpdate(doc, read(path), 'git');
      changedNotes.add(p.noteId);
    }

    // 2. `updated` (A743): this writer's key, set once per commit, on notes it changed.
    for (const [id, at] of this.dirty) {
      const doc = this.notes.get(id);
      if (!doc) continue;
      const key = `changedAt/${this.writer.id}`;
      if (doc.get('meta').getAttr(key) !== at) doc.transact(() => doc.get('meta').setAttr(key, at));
    }

    // 3. Names (stored claims, A743) and the render, unless a newer render version owns it.
    const changes = new Map();
    const renders = meta === null || (meta.renderVersion ?? 0) <= RENDER_VERSION;
    const known = new Set([...this.notes.keys(), ...purged, ...P.readWorkspace(this.workspace).notes.map((n) => n.id)]);
    const foreign = foreignOf(files, read, t.root, known);
    let noteCount = 0;
    let claims = 0;
    const claimsDoc = CLAIMS === 'commit' ? forkDoc(this.workspace, this.rng) : this.workspace;
    if (renders) {
      const named = assignNames({ workspace: this.workspace, notes: this.notes, purged, foreign, root: t.root });
      claims = this.storeClaims(named, claimsDoc);
      // Titles for `[[path|Title]]` (A10) when a link text is not the title.
      for (const [id, n] of named.names) n.title = P.readTitle(this.notes.get(id));
      const wanted = new Map();
      const headPath = new Map([...foreign.penmoss].map(([path, id]) => [id, path]));
      // Rendered files someone else changed since the last synced head (a hand edit, A743:
      // overwritten on the next render, and listed in Status). No last head: render them all.
      const touched = t.changed(this.lastHead, head, t.root);
      const handEdited = new Set();
      if (touched) {
        for (const path of touched) {
          const id = foreign.penmoss.get(path);
          if (id) handEdited.add(id);
        }
      }
      const renderSet = fullRender || !touched ? null : this.renderSet(named, changedNotes, headPath, handEdited);
      // What the render set holds for reasons of its own: a hand edit is only a file outside it.
      const ownReasons = renderSet ? this.renderSet(named, changedNotes, headPath) : new Set();
      for (const [id, path] of named.paths) {
        const doc = this.notes.get(id);
        if (renderSet && !renderSet.has(id) && headPath.get(id) === path) {
          wanted.set(path, null); // keep the bytes at head
          continue;
        }
        const bytes = enc.encode(renderOne(doc, id, path, named.names, named.paths, t.root));
        wanted.set(path, bytes);
        this.stats.rendered++;
        if (handEdited.has(id) && !ownReasons.has(id) && headPath.get(id) === path && !sameBytes(bytes, read(path))) {
          this.events.push({ type: 'overwrote-hand-edit', noteId: id, path });
        }
      }
      if (checkRenderSet && renderSet) {
        for (const [id, path] of named.paths) {
          if (renderSet.has(id) && headPath.get(id) === path) continue;
          if (headPath.get(id) !== path) continue;
          const full = enc.encode(renderOne(this.notes.get(id), id, path, named.names, named.paths, t.root));
          if (!sameBytes(full, read(path))) {
            this.stats.renderSetMisses++;
            this.events.push({ type: 'render-set-miss', noteId: id, path });
            wanted.set(path, full);
          }
        }
      }
      for (const [path] of foreign.penmoss) if (!wanted.has(path)) changes.set(path, null);
      for (const [path, bytes] of wanted) {
        if (bytes === null) continue;
        if (!sameBytes(bytes, files.has(path) ? read(path) : null)) changes.set(path, bytes);
      }
    }

    // 4. Own files (A741): own at head plus local state minus head state; purged notes' files go.
    const byDoc = new Map();
    for (const path of files.keys()) {
      const p = L.parse(path);
      if (!p || (p.kind !== 'note' && p.kind !== 'workspace')) continue;
      const key = p.kind === 'note' ? p.noteId : '';
      if (!byDoc.has(key)) byDoc.set(key, []);
      byDoc.get(key).push([path, p.writer]);
    }
    const ownChange = (key, doc, path) => {
      const parts = byDoc.get(key) ?? [];
      const own = parts.find(([, w]) => w === this.writer.id);
      const next = ownFile(
        Y.encodeStateAsUpdate(doc),
        parts.map(([p]) => read(p)),
        own ? read(own[0]) : null,
      );
      if (next) changes.set(path, next);
      return next !== null;
    };
    ownChange('', claimsDoc, L.workspace(this.writer.id));
    for (const [id, doc] of this.notes) {
      if (ownChange(id, doc, L.note(id, this.writer.id))) noteCount++;
    }
    for (const id of purged) for (const [path] of byDoc.get(id) ?? []) changes.set(path, null);

    // 5. The actor file (A749): the union of the file at head and this writer's client ids.
    const actorPath = L.actor(this.writer.id);
    const atHead = files.has(actorPath) ? JSON.parse(dec.decode(read(actorPath))) : { clientIds: [] };
    const forkClient = claimsDoc !== this.workspace && claims > 0 ? [claimsDoc.clientID] : [];
    const clientIds = [...new Set([...atHead.clientIds, ...this.ownClients, ...forkClient])].sort((a, b) => a - b);
    if (clientIds.length !== atHead.clientIds.length || !files.has(actorPath)) {
      changes.set(actorPath, enc.encode(`${JSON.stringify({ kind: this.writer.kind, label: this.writer.label, clientIds }, null, 2)}\n`));
    }
    if (meta === null) {
      changes.set(L.notebook, enc.encode(`${JSON.stringify({ id: ulidAt(this.clock.now(), this.rng), name: 'Work', format: FORMAT, renderVersion: RENDER_VERSION }, null, 2)}\n`));
    }
    const onlyActor = [...changes.keys()].every((p) => p === actorPath);
    if (changes.size === 0 || (onlyActor && files.has(actorPath) && noteCount === 0)) {
      return { head, commit: null, changes };
    }
    const landed = () => {
      if (forkClient.length === 0) return;
      Y.applyUpdate(this.workspace, Y.encodeStateAsUpdate(claimsDoc, Y.encodeStateVector(this.workspace)), 'claims');
      this.ownClients.add(claimsDoc.clientID);
    };
    const message = `Penmoss: ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} [skip ci]`;
    const commit = t.commitOnHead(head, changes, message);
    return { head, commit, changes, noteCount, landed };
  }

  /**
   * The render set (A743): notes whose logs changed or that this device changed, notes with no
   * file at their path yet, notes whose path moved, and notes linking to a note whose name or
   * presence changed.
   */
  renderSet(named, changedNotes, headPath, handEdited = new Set()) {
    const set = new Set([...changedNotes, ...this.dirty.keys(), ...handEdited]);
    if (MUTATE === 'render-set') return new Set(this.dirty.keys());
    const renamed = new Set();
    for (const [id, path] of named.paths) {
      if (headPath.get(id) !== path) {
        set.add(id);
        renamed.add(id);
      }
    }
    for (const [id] of headPath) if (!named.paths.has(id)) renamed.add(id);
    for (const id of set) if (!renamed.has(id) && named.paths.has(id)) renamed.add(id); // title may differ
    if (renamed.size > 0) {
      for (const [id] of named.paths) {
        if (set.has(id)) continue;
        for (const target of linkTargets(this.notes.get(id))) {
          if (renamed.has(target)) {
            set.add(id);
            break;
          }
        }
      }
    }
    return set;
  }

  /** Writes the names this render used back as claims, only where they differ (no ping-pong). */
  storeClaims(named, doc = this.workspace) {
    const folders = doc.get('folders');
    const registry = doc.get('notes');
    const writes = [];
    for (const [id, name] of named.assigned) {
      const node = folders.getAttr(id);
      if (node instanceof Y.Node && JSON.stringify(storedJson(node, FOLDER_NAME_ATTR)) !== JSON.stringify(name)) {
        writes.push([node, FOLDER_NAME_ATTR, { ...name }]);
      }
    }
    for (const [id, name] of named.names) {
      const node = registry.getAttr(id);
      const value = { base: name.base, name: name.name };
      if (node instanceof Y.Node && JSON.stringify(storedJson(node, NOTE_NAME_ATTR)) !== JSON.stringify(value)) {
        writes.push([node, NOTE_NAME_ATTR, value]);
      }
    }
    if (writes.length > 0) {
      doc.transact(() => {
        for (const [node, attr, value] of writes) node.setAttr(attr, value);
      });
    }
    return writes.length;
  }

  /** Every file this clone would write under the directory, rendered in full from its state. */
  fullRender(files, read) {
    const purged = this.purgedIds();
    const known = new Set([...this.notes.keys(), ...purged, ...P.readWorkspace(this.workspace).notes.map((n) => n.id)]);
    const foreign = foreignOf(files, read, this.t.root, known);
    const named = assignNames({ workspace: this.workspace, notes: this.notes, purged, foreign, root: this.t.root });
    for (const [id, n] of named.names) n.title = P.readTitle(this.notes.get(id));
    const out = new Map();
    for (const [id, path] of named.paths) {
      out.set(path, renderOne(this.notes.get(id), id, path, named.names, named.paths, this.t.root));
    }
    return { out, foreign };
  }
}

/** ISO 8601 in America/Chicago's October offset, as a device there writes `created`. */
export function isoAt(ms) {
  const local = new Date(ms - 5 * 3600_000).toISOString().slice(0, 19);
  return `${local}-05:00`;
}

const WORDS =
  'the quick brown fox jumps over lazy dog meeting notes project plan review budget design spike gate merge sync commit push fetch writer render folder title journal inbox agent device pixel mac branch remote'.split(
    ' ',
  );
export { WORDS };
