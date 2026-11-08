# Penmoss runbook: backups

Penmoss has no server (D48, D49). A git notebook's backup is its repository: the git host keeps it, and every device's clone is a full copy of everything that device has synced. To back up a notebook elsewhere, clone or mirror its repository (`git clone --mirror <remote>`).

The relay (`apps/relay`, [relay.md](relay.md)) holds a working copy of one notebook in a Durable Object, and nothing that is not also in the repository once it has pushed. If its copy is lost, it starts again from the repository.

## The server's final backup

Before the Cloudflare server was deleted (T59, 4 Nov 2026), its data was exported and checked:

- **D1:** every table except the full-text index's virtual tables (`wrangler d1 export` cannot export those, and they are rebuildable), loaded back into SQLite with row counts equal to production's (51 notes, 1 user, 13 devices, 27 tokens, 23 attachments).
- **R2 (`penmoss-notes`):** all 108 objects (notes' markdown and comment threads, attachments, the workspace's Yjs backups and the auth exports), each checked against its size and MD5.

Ryan keeps that backup offline. The notes themselves had already moved into the `htxryan/penmoss-notebook` git notebook (T56), with their history in one import commit; the server's per-note version history lived only in its Durable Objects, and Ryan chose to let it go with them (4 Nov 2026) rather than export it.
