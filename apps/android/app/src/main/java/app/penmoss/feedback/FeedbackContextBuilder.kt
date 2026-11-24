package app.penmoss.feedback

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/*
 * The captured context's six groups on Android (T49, A791), from facts the app gathers when the
 * form opens (FeedbackCapture). Metadata only: never a note's body text, excerpts, search queries
 * or other notes' text. A note's text is only ever an input here to tell which errors quote it.
 */

/** Group 1: the app, the phone and how it looks. */
data class AppFacts(
    val version: String,
    val os: String,
    val webView: String?,
    val screen: String,
    val theme: String,
    val appearance: String,
    val locale: String,
    val timeZone: String,
    val window: String = "main",
)

/** Group 2: where the person was. Route ids are kept; no query string or search text. */
data class WhereFacts(
    val route: String,
    val screen: String,
    val panel: String?,
    val openedFrom: String,
    val folderPath: String?,
)

/** Group 3: sync as the phone sees it. */
data class SyncFacts(
    val online: Boolean,
    val sync: String,
    val socket: String,
    val lastSynced: Long?,
    val unsyncedNotes: Int,
    val outbox: Int,
    val feedbackOutbox: Int,
    val lastError: String,
)

/** Group 4: the open note's metadata. */
data class NoteFacts(
    val id: String,
    val title: String,
    val folderPath: String,
    val tags: List<String>,
    val created: String?,
    val updated: Long?,
    val words: Int?,
    val characters: Int?,
    val attachments: Int?,
    val sizeBytes: Long?,
    val engine: String?,
    val unsynced: Boolean,
    val inTrash: Boolean,
    val backlinks: Int?,
    val outgoingLinks: Int?,
    val windows: Int = 1,
)

object FeedbackContextBuilder {
    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** `2026-10-27T15:04:05.000Z`, as JavaScript's `toISOString`. */
    fun iso(time: Long): String = ISO.format(Instant.ofEpochMilli(time))

    /**
     * Every report comes from a git notebook (A826, A828, A889; PEN-137, O5): nothing of the
     * notebook goes. Its screen and the note are named only by kind, with counts and sync states:
     * no note id, title, folder path, notebook name, tags, route, dates or authors. The server
     * era's rows (Title, Folder, Tags, Notebook, Route, Id, Selected folder) are gone.
     */
    fun build(
        app: AppFacts,
        where: WhereFacts,
        sync: SyncFacts,
        note: NoteFacts?,
        errors: List<RecentErrors.Entry>,
        /** The open note's text as the phone holds it: only to drop errors that quote it. */
        noteText: String,
        /** Note titles and folder names to scrub errors of; null while the phone knows none. */
        names: Collection<String>?,
    ): FeedbackContextData = gitContext(app, where, sync, note, errors, noteText, names)

    /** What [build] sends from a git notebook: kinds, counts and states only (A889). */
    const val GIT_NOTICE = "nothing of the notebook is sent: no note id, title, folder, tags, dates, authors or screen capture"

    private fun gitContext(
        app: AppFacts,
        where: WhereFacts,
        sync: SyncFacts,
        note: NoteFacts?,
        errors: List<RecentErrors.Entry>,
        noteText: String,
        names: Collection<String>?,
    ): FeedbackContextData {
        val groups = mutableListOf(
            fieldGroup(
                FeedbackGroupId.APP,
                listOf(
                    "Client" to "Android",
                    "Version" to app.version,
                    "OS" to app.os,
                    "WebView" to app.webView,
                    "Window" to app.window,
                    "Screen" to app.screen,
                    "Theme" to app.theme,
                    "Appearance" to app.appearance,
                    "Locale" to app.locale,
                    "Time zone" to app.timeZone,
                ),
            ),
            fieldGroup(
                FeedbackGroupId.WHERE,
                listOf(
                    // The screen's kind, never its route: a note's or a folder's id is the notebook's.
                    "Screen" to where.screen,
                    "Open panel" to (where.panel ?: "none"),
                    "Opened from" to where.openedFrom,
                    "Source" to "a git notebook",
                    "Git notebook" to GIT_NOTICE,
                ),
            ),
            fieldGroup(
                FeedbackGroupId.SYNC,
                listOf(
                    "Online" to sync.online,
                    "Sync" to sync.sync,
                    "Socket" to sync.socket,
                    "Last synced" to (sync.lastSynced?.let(::iso) ?: "never"),
                    "Unsynced notes" to sync.unsyncedNotes,
                    "Outbox" to sync.outbox,
                    "Feedback outbox" to sync.feedbackOutbox,
                    // Its words can name the repository, a folder or a note: only whether there was one.
                    "Last sync error" to if (sync.lastError.isBlank() || sync.lastError == "none") "none" else "yes (not sent from a git notebook)",
                ),
            ),
        )
        if (note != null) {
            groups += fieldGroup(
                FeedbackGroupId.NOTE,
                listOf(
                    "Source" to "a git notebook",
                    "Words" to note.words,
                    "Characters" to note.characters,
                    "Attachments" to note.attachments,
                    "Size in bytes" to note.sizeBytes,
                    "Unsynced" to note.unsynced,
                    "In Trash" to note.inTrash,
                    "Backlinks" to note.backlinks,
                    "Outgoing links" to note.outgoingLinks,
                ),
            )
        }
        groups += tableGroup(FeedbackGroupId.ERRORS, ERROR_COLUMNS, errors(errors, noteText, names))
        return FeedbackContextData(groups)
    }

    /**
     * The recent errors, newest first, as [ErrorScrub] leaves them (A427) and then without
     * tokens, emails or URL queries; one quoting the open note's text is dropped (A791).
     */
    fun errors(entries: List<RecentErrors.Entry>, noteText: String, names: Collection<String>?): List<List<String>> =
        entries.asReversed().mapNotNull { entry ->
            if (FeedbackRedaction.quotesNoteText(entry.free, noteText) || FeedbackRedaction.quotesNoteText(entry.detail, noteText)) return@mapNotNull null
            val (message, detail) = ErrorScrub.scrubbed(entry.fixed, entry.free, entry.detail, names)
            val shownMessage = FeedbackRedaction.secrets(message)
            val stack = FeedbackRedaction.secrets(appFrames(detail))
            if (FeedbackRedaction.quotesNoteText(shownMessage, noteText) || FeedbackRedaction.quotesNoteText(stack, noteText)) return@mapNotNull null
            listOf(iso(entry.at), shownMessage, stack)
        }.take(FeedbackLimits.RECENT)

    private val FRAME = Regex("^\\s*at ")
    private val CAUSE = Regex("^\\s*(Caused by|Suppressed): ")

    /**
     * A stack trimmed to the app's frames (and what caused it), a few at most; with none of the
     * app's, its first frames.
     */
    fun appFrames(detail: String): String {
        val lines = detail.lines()
        val frames = lines.filter { FRAME.containsMatchIn(it) }
        val ours = lines.filter { line -> CAUSE.containsMatchIn(line) || (FRAME.containsMatchIn(line) && line.contains("app.penmoss.")) }
        val kept = if (ours.any { FRAME.containsMatchIn(it) }) ours.take(MAX_FRAMES) else frames.take(3)
        return kept.joinToString("\n") { it.trim() }
    }

    private const val MAX_FRAMES = 8
}
