# ADR 0003: CRDT stack (Yjs 14) and NoteDoc sync

- Status: Accepted (D31). Ryan reviews the spike results at Checkpoint A (#36)
- Date: 22 October 2026
- Task: T4 ([#4](https://github.com/htxryan/penmoss/issues/4))

## Context

D16 makes Yjs the CRDT and asks T4 to build the sync spike twice: on Yjs 13 with TipTap's Collaboration extension, and on the Yjs 14 release candidate (`@y/y` + `@y/prosemirror` 2) wired into TipTap directly. Yjs 14 is chosen only if TipTap edits cleanly through it (undo included), offline merge works on the Durable Object, and its attributions show who wrote what. Nothing is stored yet, so this is the cheapest point to move. The spike also had to prove the NoteDoc design (A1, A3, A5, A7) on the Workers Free plan (D20): a thin Worker, merging inside the Durable Object.

Both stacks run on the same engine-agnostic code. `packages/sync-client` defines a `Replica` interface with a Yjs 13 and a Yjs 14 implementation. The wire protocol, the `SyncProvider`, the IndexedDB `NoteStore` and the `NoteDoc` Durable Object only use that interface. `packages/editor` binds TipTap to either replica (`createCollabEditor`). The Yjs version is fixed per note when the note is created.

## Decision

1. **Use Yjs 14**: `@y/y` 14.0.0-rc.29 with `@y/prosemirror` 2.0.0-15, pinned exactly, wired into TipTap 3.32.0 through `syncPlugin`, `yUndoPlugin` and `configureYProsemirror` (TipTap's Collaboration extension wraps the old binding). Yjs 14 met all three D16 conditions. Yjs 13 passed the acceptance criteria too, but its views diverged in one concurrency case (below).
2. **Stop editor plugins from repairing content the binding just rendered.** Wrap every plugin's `appendTransaction` so it does nothing for binding transactions (`skipRepairsOfBindingChanges` in `packages/editor/src/collab/yjs14.ts`, the same approach as `guards.js` in y-prosemirror's TipTap demo). Without the wrapper, a concurrent add-row and add-column makes both peers pad the ragged row with `fixTables`, write the padding into Yjs and answer each other's padding: the table gains one column per sync round, without end.
3. **NoteDoc is a thin Yjs-protocol handler, not y-partyserver.** y-partyserver 2.2.0 needs `yjs` ^13 as a peer dependency. It saves the whole document through a debounced `onSave` (2 s, at most 10 s), so an acknowledged edit can be lost in that window. It also has no per-update hook that knows the connection, which the clientID→actor table needs. The handler (`apps/server/src/do/note-doc.ts`, with its SQLite layer in `note-storage.ts`) is about 500 lines.

### NoteDoc (apps/server)

- **Hibernatable WebSockets** (`ctx.acceptWebSocket`). The connection's actor is kept in the socket attachment. After hibernation, the in-memory replica is rebuilt from the snapshot plus the update tail on the next event: about 13 ms for a 1 MB note on either stack.
- **SQLite.** Every client update is appended to `updates` in the same synchronous turn, before it is broadcast. That includes updates Yjs holds as pending, so nothing is lost across hibernation. An update that changes nothing (no new structs, deletions or pending content, such as the delete set a reconnecting client always resends) is not stored. After 100 updates or 512 KiB, the tail is compacted into one snapshot (`encodeStateAsUpdate`). Snapshots and versions are split into 1 MiB chunks, because a Durable Object SQLite row is limited to 2 MB.
- **Attribution (A3).** Client IDs come from each update's own insert structs (`Replica.insertRanges`), checked before the update is applied. A client ID with no actor yet is mapped to the sending connection's actor in `client_actors` once the update is stored. Structs the Durable Object already holds, integrated or pending, may be resent by anyone. New structs under a client ID owned by another actor are rejected: nothing is applied and the socket is closed with 1008. Client IDs that appear only in a delete set are never mapped, and pending structs keep the actor that sent them, not the one whose update unblocks them (T6, #5). Actors (`id`, `kind`, `label`) live in `actors`. The actor currently comes from query parameters. That is a stub, marked TODO(T5). Versions are full state copies with actor, reason and time.
- **Epoch (A5)** is created with the note and sent in a `session` message on every connection. The client stores it in IndexedDB. T8 handles a changed epoch.
- **Worker (D20).** `/notes/:id/sync` validates the note ID, the upgrade header and the actor, then forwards the request to the Durable Object. The Worker does no Yjs work.

### Wire protocol and client (packages/sync-client)

- Message types 0 (sync) and 1 (awareness) are byte-compatible with y-protocols. Type 100 is the Penmoss session message (epoch, engine, actor). Awareness is relayed and never stored.
- **Handshake with confirmation.** The server sends its step 1. The client answers with its step 2, then sends its own step 1. The Durable Object handles messages in order, so its step-2 reply confirms that the client's offline edits are stored. Live edits are confirmed the same way by a step-1 probe sent 500 ms after the last edit. This drives the `unsynced` flag, which is stored in IndexedDB for T8's pending count.
- **IndexedDB (A7).** One database (`penmoss`) with one object store (`notes`) keyed by note ID. Each record holds `{engine, update, stateVector, text, epoch, updatedAt, unsynced}`. Offline edits need no separate queue: they are part of the stored merged update, and the state-vector handshake uploads exactly what the server lacks.

## Evidence

All numbers are from the agent worker (4 vCPU) on 22 October 2026: workerd 1.20261019.1 through `@cloudflare/vitest-plugin` and `wrangler dev`, Chromium 156, Node 24.

| Criterion                                                  | Yjs 13 (yjs 13.6.33, TipTap Collaboration)                                            | Yjs 14 (@y/y rc.29, @y/prosemirror 2.0.0-15)                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Interleaved offline edits merged on the Durable Object     | Pass                                                                                  | Pass                                                                              |
| Two browser contexts, one offline (`context.setOffline`)   | Pass, identical content                                                               | Pass, identical content                                                           |
| Concurrent edits in one table cell and one nested callout  | Pass, both kept, plus add row and split block                                         | Pass, both kept, plus add row and split block                                     |
| Add row on one peer, add column on the other               | Stable 3 × 3                                                                          | Without the guard, one more column per sync round; with it stable (3, 3, 2 cells) |
| Concurrent deletes empty a `block+` callout                | **Views diverge from Yjs and each other** (each shows a paragraph Yjs no longer has)  | Converges: the empty callout is dropped everywhere                                |
| Typing in a table row deleted concurrently                 | Delete wins                                                                           | Delete wins                                                                       |
| Undo after a remote merge                                  | Undoes local edits only                                                               | Undoes local edits only                                                           |
| Attribution (who wrote what)                               | Our own walk over Yjs items, mapped through `client_actors`                           | Yjs 14 `AttributionsRenderer` with a content map built from `client_actors`       |
| Compaction, then eviction, then a late joiner              | Pass                                                                                  | Pass                                                                              |
| 1 MB note to a fresh client, browser (socket open → shown) | 45–50 ms                                                                              | 106–109 ms                                                                        |
| 1 MB note to a fresh client, workerd, cold Durable Object  | 27 ms                                                                                 | 16 ms                                                                             |
| NoteDoc costs for a 1 MB note                              | load 13–14 ms, keystroke p50 0.010 ms (p99 0.2–0.8 ms), compaction 10–11 ms           | load 12–13 ms, keystroke p50 0.009 ms (p99 0.4–0.5 ms), compaction 8–12 ms        |
| Client bundle, Yjs layer only (min + gzip)                 | +40 KB gzip (+124 KB min)                                                             | +55 KB gzip (+175 KB min)                                                         |
| Shared by both stacks                                      | Worker route CPU: first request 1.5 ms, then p50 0.003 ms, p99 0.007 ms (limit 10 ms) | 5,000 notes (36 MB of Yjs state) opened and listed from IndexedDB in 267–287 ms   |

The table and callout cases ran in happy-dom (`packages/editor/test/collab.test.ts`) and again in real Chromium through the Durable Object. Worker CPU was measured in Node, which runs the same V8 as workerd, with a stubbed Durable Object namespace (`apps/server/perf`). The first request includes Hono compiling its routes. Neither stack attributes deletions, because Yjs delete sets carry no client ID. Yjs 14 can attribute them from a diff between two versions (`createContentIdsFromDocDiff`), which T21 can use.

## Consequences

- **Release-candidate churn.** `@y/y` publishes every week or two, and npm's `latest` tag still points at rc.7 while `beta` is rc.29. Versions are pinned exactly. An upgrade is a deliberate change that must pass the T4 suites (server, editor and e2e) and record its new pins in the plan. Move to 14.0.0 when it is released.
- **We own the TipTap wiring.** TipTap's Collaboration and CollaborationCaret extensions and Hocuspocus target Yjs 13. Shared cursors would need `yCursorPlugin` with `@y/protocols` awareness, which is not tested yet. That is low priority while v1 is single-user (D3).
- **The repair guard covers late plugins.** TipTap builds the plugin list when the view mounts and again in `registerPlugin`. The editor (`GuardedEditor` in `yjs14.ts`) wraps plugins at both points (T6), so a plugin a menu registers later is guarded too.
- **Content written by Yjs 14 cannot be read by Yjs 13.** Falling back after real notes exist means converting each note through markdown with the T3 codec. Android is unaffected, because Kotlin only handles opaque bytes (A11). Yjs 14 client IDs are 53-bit; SQLite `INTEGER` and JavaScript numbers hold them.
- **Schema.** On both stacks, a `block+` container emptied by concurrent deletes is removed. T9 and T11 should decide whether callouts accept that or relax to `block*`, as @y/prosemirror's CAVEATS.md recommends.
- **Revisit** if a Yjs 14 data-loss or divergence bug stays unfixed, if the release candidate stalls, or if a Phase 2 block (T9–T12) cannot be made to work with the binding. The `Replica` interface keeps the Durable Object, provider and IndexedDB code engine-agnostic, so returning to Yjs 13 before M1 means restoring its replica and editor factory from git history (removed in T6) and adding it back to `EngineName`.

## Pinned versions (T4)

| Package                                                                     | Version                        | Note                                                                               |
| --------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `@y/y`                                                                      | 14.0.0-rc.29                   | npm `beta` tag; brings lib0 1.0.0-rc.36                                            |
| `@y/prosemirror`                                                            | 2.0.0-15                       | npm `beta` tag                                                                     |
| `@y/protocols`                                                              | 1.0.6-rc.1                     | Peer dependency of `@y/prosemirror`; sync-client's wire-compatibility test         |
| TipTap `core`, `pm`, `starter-kit`, `extension-table`                       | 3.32.0                         | prosemirror-model 1.25.12, -state 1.4.4, -view 1.42.6, -transform 1.12.2 (deduped) |
| lib0                                                                        | 0.2.119                        | Wire codec in `packages/sync-client`                                               |
| `yjs`, `y-protocols`, `@tiptap/extension-collaboration`, `@tiptap/y-tiptap` | 13.6.33, 1.0.7, 3.32.0, 3.0.10 | Yjs 13 comparison stack; removed in T6 (#6), the T4 numbers above are its record   |
| fake-indexeddb, happy-dom                                                   | 6.2.6, 21.0.4                  | Tests                                                                              |
