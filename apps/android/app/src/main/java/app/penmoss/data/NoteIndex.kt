package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.api.TagCount
import app.penmoss.engine.sync.ExchangeResult
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.serialization.builtins.ListSerializer

/**
 * What the phone knows of notes' words offline (T40 P6, P7, T38): the offline index's text and
 * tags for search, the tag list's suggestions, and the links behind backlinks and the graph.
 */
class NoteIndex(
    private val db: PenmossDatabase,
    private val now: () -> Long,
    private val folders: FolderOps,
) {
    private val notes = db.notes()
    private val updates = db.updates()
    private val settings = db.settings()
    private val search = db.search()

    /** When the page last changed each note's own links in this process (T40 P7 review S3). */
    private val ownLinksAt = MutableStateFlow<Map<String, Long>>(emptyMap())

    // --- the offline index and tags (T40 P6, FD3, FD4) ---

    /** The note's row in the offline index: [text] and [headings], its title and tags as Room holds them, folded. */
    private suspend fun putText(noteId: String, text: String, headings: String) {
        val note = notes.note(noteId) ?: return
        search.putText(NoteTextEntity.of(noteId, note.title, text, search.tagsOf(noteId).joinToString(" "), headings))
    }

    /**
     * The open note's text, headings and tags from the editor page (FD4): this phone's own
     * edits, found offline before the server has them. Its hash goes with the next exchange, so
     * the server sends its text only once it differs (the edits merged with others'). The same
     * text again writes nothing (review B2). Its tags are this phone's own (review S5): the tag
     * browser and filter see a tag typed here at once, until a landed `/sync/changes` row once
     * the edits are sent replaces them.
     */
    suspend fun savePageText(noteId: String, text: String, headings: String = "", tags: List<String> = emptyList()) = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction
        val hash = textHash(text, headings)
        val now = tags.distinct().sorted()
        val tagsChanged = search.tagsOf(noteId) != now
        if (tagsChanged) {
            search.clearTags(noteId)
            search.addTags(now.map { NoteTagEntity(noteId, it) })
        }
        if (hash == note.textHash && !tagsChanged) return@withTransaction
        putText(noteId, text, headings)
        if (hash != note.textHash) notes.setText(noteId, hash, due = note.textDue)
    }

    /** The note's tags, and its index row refolded with its title and tags. */
    internal suspend fun saveTags(noteId: String, tags: List<String>) {
        val now = tags.distinct().sorted()
        if (search.tagsOf(noteId) != now) {
            search.clearTags(noteId)
            search.addTags(now.map { NoteTagEntity(noteId, it) })
        }
        reindex(noteId)
    }

    /** The note's index row again, its text kept, with the title and tags Room holds now. */
    private suspend fun reindex(noteId: String) {
        val row = search.text(noteId) ?: return
        val note = notes.note(noteId) ?: return
        val tags = search.tagsOf(noteId).joinToString(" ")
        if (row.title == note.title && row.tags == tags) return
        search.putText(NoteTextEntity.of(noteId, note.title, row.body, tags, row.headings))
    }

    /**
     * A tag renamed on the server (TG3, review S5): [from] becomes [to] here at once, the tags
     * under it too (`a/x` becomes `b/x`), on [noteIds] (the notes the server named). The rows a
     * later `/sync/changes` lands correct it.
     */
    suspend fun renameTagLocally(from: String, to: String, noteIds: List<String>) = db.withTransaction {
        if (noteIds.isEmpty()) return@withTransaction
        val byNote = search.tagsOfNotes(noteIds).groupBy({ it.noteId }, { it.tag })
        for ((noteId, tags) in byNote) {
            val renamed = tags.map { tag ->
                when {
                    tag == from -> to
                    tag.startsWith("$from/") -> to + tag.substring(from.length)
                    else -> tag
                }
            }.distinct().sorted()
            if (renamed == tags.sorted()) continue
            search.clearTags(noteId)
            search.addTags(renamed.map { NoteTagEntity(noteId, it) })
            reindex(noteId)
        }
    }

    /** Every tag on a live note and how many carry it, A–Z, from Room (offline). */
    fun observeTagCounts(): Flow<List<TagCountRow>> = search.observeTagCounts()

    /** One note's own tags, frontmatter and inline, as the phone has them (TG6, A656). */
    fun observeTagsOf(noteId: String): Flow<List<String>> = search.observeTagsOf(noteId)

    /** Each live note's tags, by note (T40 P6, TG1). */
    fun observeNoteTags(): Flow<List<List<String>>> = search.observeNoteTags().map { rows ->
        rows.groupBy({ it.noteId }, { it.tag }).values.toList()
    }

    /** The live notes with [tag] or a tag under it, newest first (TG2). */
    fun observeTagged(tag: String): Flow<List<NoteListRow>> = search.observeTagged(tag)

    /** Every note held with [tag] or a tag under it: the ids a rename sends (TG3). */
    suspend fun taggedIds(tag: String): List<String> = search.taggedIds(tag)

    /** This phone's sendable edits, to any note, and waiting captures: a rename waits for them (TG3, A468, review S4, R2). */
    fun observeUnsent(): Flow<Int> = search.observeUnsent()

    /**
     * The offline index's side of an exchange (T40 P6, FD4): the server's text is kept only once
     * the server holds every edit made here (else it lacks them, and the page's text stands until
     * they are sent). A reply that applied or restored and says the phone's copy is current
     * settles it, as does an older server's applied reply, which sends no text at all (A463);
     * any other reply (deferred, kept apart) leaves it due (review nit). Content that changed on
     * a pass that asked for no text (metered, A328) leaves the text due for the next pass that
     * may prefetch.
     */
    internal suspend fun saveExchangedText(result: ExchangeResult) {
        val id = result.noteId
        if (!result.textAsked) {
            if (result.append != null) notes.setTextDue(id, true)
            return
        }
        val text = result.text
        when {
            text != null && updates.count(id, UpdateEntity.PENDING) == 0 -> {
                val headings = result.headings.orEmpty()
                putText(id, text, headings)
                notes.setText(id, result.textHash ?: textHash(text, headings), due = false)
            }
            text != null -> Unit
            result.textHash != null && (result.kind == ExchangeResult.Kind.APPLIED || result.kind == ExchangeResult.Kind.RESET) -> notes.setTextDue(id, false)
            result.textHash == null && result.kind == ExchangeResult.Kind.APPLIED -> notes.setTextDue(id, false)
            else -> Unit
        }
    }

    // --- links (T40 P7) ---

    /** Replaces the notes [noteId] links to (A473); never itself. */
    internal suspend fun replaceLinks(noteId: String, targets: Collection<String>) {
        val links = db.noteLinks()
        links.clearFrom(noteId)
        links.insertAll(targets.filter { it != noteId }.distinct().map { NoteLinkEntity(noteId, it) })
    }

    /**
     * The notes the open note links to, as the editor page reads them from its own document
     * (T40 P7, A473): the phone's own edits show in backlinks before the server indexes them.
     */
    suspend fun setOwnLinks(noteId: String, targets: List<String>) = db.withTransaction {
        if (db.noteLinks().targetsOf(noteId) != targets.filter { it != noteId }.distinct().sorted()) {
            replaceLinks(noteId, targets)
            ownLinksAt.update { it + (noteId to now()) }
        }
    }

    /**
     * Notes edited here that the server's index may not have reached (T40 P7 review S3, as the
     * web's `withRecent`): those with edits not sent, and those whose links the page changed in
     * the last [INDEX_LAG_MS]. For them Room's links, not the server's backlinks, say whether
     * they link to a note. The second set is this process's only: after a restart the index
     * has long caught up.
     */
    fun observeRecentLinkers(): Flow<Set<String>> =
        combine(updates.observePendingNoteIds(), ownLinksAt) { pending, own ->
            val since = now() - INDEX_LAG_MS
            pending.toSet() + own.filterValues { it > since }.keys
        }

    /** The notes [noteId] links to, sorted. */
    suspend fun linksOf(noteId: String): List<String> = db.noteLinks().targetsOf(noteId)

    /** What the graph is drawn from (T40 P7, LK7, LK8; A478): live notes, their links, the folders. */
    fun observeGraph(): Flow<GraphSource> =
        combine(notes.observeDirectory(), db.noteLinks().observeAll(), db.folders().observeAll(), folders.observeRootSortMode(), ::GraphSource)

    /** The live notes linking to [noteId], most recently edited first (LK5), offline. */
    fun observeBacklinkSources(noteId: String): Flow<List<BacklinkSource>> = db.noteLinks().observeSources(noteId)

    suspend fun cachedBacklinks(noteId: String): BacklinksCacheEntity? = db.backlinksCache().get(noteId)

    suspend fun cacheBacklinks(noteId: String, json: String) {
        db.backlinksCache().put(BacklinksCacheEntity(noteId, json, now()))
    }

    // --- tags (T38) ---

    /**
     * The workspace's tags and how many notes carry each, as `/api/tags` last said, for the
     * tag sheet's suggestions offline too. Tags themselves live in each note's document.
     */
    fun observeTagList(): Flow<List<TagCount>> = settings.observe(TAG_LIST).map(::tagsOf)

    suspend fun saveTagList(tags: List<TagCount>) = settings.put(SettingEntity(TAG_LIST, PenmossJson.encodeToString(TAG_LIST_JSON, tags)))

    /** A tag added on this phone is suggested at once, before the server has indexed it. */
    suspend fun rememberTag(tag: String) = db.withTransaction {
        val known = tagsOf(settings.get(TAG_LIST))
        if (known.none { it.name == tag }) saveTagList(known + TagCount(tag, 1))
    }

    private fun tagsOf(json: String?): List<TagCount> =
        json?.let { runCatching { PenmossJson.decodeFromString(TAG_LIST_JSON, it) }.getOrNull() }.orEmpty()

    private companion object {
        /** How long after a change the server's index may still lag, as the web's `INDEX_LAG_MS`. */
        const val INDEX_LAG_MS = 60_000L
        const val TAG_LIST = "tagList"
        val TAG_LIST_JSON = ListSerializer(TagCount.serializer())
    }
}

/**
 * The SHA-256 of a note's text and headings in lower-case hex, as the server hashes them (core's
 * `noteTextKey`: the text, a NUL, the headings; T40 P6, FD4). An unpaired surrogate encodes as
 * `?` here and U+FFFD in the browser's `TextEncoder`, so such a note never matches the server's
 * hash and its text comes again on each exchange that asks: harmless (review N5).
 */
internal fun textHash(text: String, headings: String = ""): String =
    java.security.MessageDigest.getInstance("SHA-256").digest("$text\u0000$headings".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
