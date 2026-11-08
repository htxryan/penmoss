package app.penmoss.feedback

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Window
import androidx.webkit.WebViewCompat
import app.penmoss.data.Notebooks
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HistoryAuthor
import app.penmoss.engine.api.NoteHistory
import app.penmoss.engine.api.PenmossJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.math.BigDecimal
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.coroutines.resume

/** What the open note's screen knows that Room does not (T49): counts and links from the editor page. */
data class NoteExtras(
    val created: String? = null,
    val words: Int? = null,
    val characters: Int? = null,
    val outgoingLinks: Int? = null,
    val tags: List<String>? = null,
)

/**
 * Gathers the captured context's facts (T49, A791) from the cache and the app's state when the
 * form opens. The open note's text is read only to count it and to tell which errors quote it;
 * it is never part of what this returns.
 */
class FeedbackCollector(
    private val db: PenmossDatabase,
    private val recent: RecentErrors,
    /** Note titles and folder names, to scrub errors of (the error reports' names, A427). */
    private val names: suspend () -> Collection<String>,
    private val app: () -> AppFacts,
    private val sync: suspend () -> SyncFacts,
    /** A git notebook's graph (A889): its context is kinds and counts only. */
    val gitNotebook: Boolean = false,
) {
    suspend fun collect(where: WhereFacts, noteId: String?, extras: NoteExtras? = null): FeedbackContextData = withContext(Dispatchers.IO) {
        val dao = db.feedback()
        val note = noteId?.let { db.notes().note(it) }
        // Read only to count it and to drop errors quoting it; never sent.
        val text = note?.let { runCatching { dao.text(it.id) }.getOrNull() }.orEmpty()
        val facts = note?.let {
            NoteFacts(
                id = it.id,
                title = it.title,
                folderPath = folderPath(it.folderId) ?: "Top level",
                tags = extras?.tags ?: dao.tags(it.id),
                notebook = notebookName(it.folderId) ?: Notebooks.defaultName(db.settings().get(Notebooks.NAME_SETTING)),
                created = extras?.created,
                updated = it.updatedAt,
                words = extras?.words ?: text.split(Regex("\\s+")).count(String::isNotEmpty),
                characters = extras?.characters ?: text.length,
                attachments = dao.attachments(it.id),
                sizeBytes = text.toByteArray(Charsets.UTF_8).size.toLong(),
                engine = ENGINE,
                epoch = it.epoch,
                unsynced = dao.pendingOf(it.id) > 0,
                inTrash = it.deleted,
                backlinks = dao.backlinks(it.id),
                outgoingLinks = extras?.outgoingLinks ?: dao.outgoingLinks(it.id),
            )
        }
        val edits = note?.let { edits(it.id) }.orEmpty()
        val known = runCatching { names() }.getOrNull()
        FeedbackContextBuilder.build(app(), where, sync(), facts, if (gitNotebook) emptyList() else edits, recent.all(), text, known, gitNotebook)
    }

    /** The notebook a folder is in, by name (T43); null for the default notebook. */
    suspend fun notebookName(folderId: String?): String? {
        folderId ?: return null
        val folders = db.folders().all()
        val notebook = Notebooks.index(folders).ofFolder(folderId) ?: return null
        return folders.firstOrNull { it.id == notebook }?.name?.ifBlank { "Untitled folder" }
    }

    /** The folder's path, top first, as Info shows it; null at the top level. */
    suspend fun folderPath(folderId: String?): String? {
        folderId ?: return null
        val chain = mutableListOf<String>()
        val seen = HashSet<String>()
        var current: String? = folderId
        while (current != null && seen.add(current)) {
            val folder = db.folders().get(current) ?: break
            chain += folder.name.ifBlank { "Untitled folder" }
            current = folder.parentId
        }
        return chain.asReversed().joinToString(" / ").ifEmpty { null }
    }

    /** The last version list read for the note (the history cache, A435): who, when and why. */
    private suspend fun edits(noteId: String): List<EditFacts> {
        val cached = db.historyCache().get(noteId) ?: return emptyList()
        val history = runCatching { PenmossJson.decodeFromString(NoteHistory.serializer(), cached.json) }.getOrNull() ?: return emptyList()
        val unversioned = history.unversioned?.let { listOf(EditFacts(it.since, actors(it.authors), "", "", unversioned = true)) }.orEmpty()
        return unversioned + history.versions.map { version -> EditFacts(version.createdAt, actors(version.authors), version.reason, version.summary) }
    }

    /** Who made a version, as the web lists them: an agent with " (agent)", a nameless author as Unknown. */
    private fun actors(authors: List<HistoryAuthor>) = authors.map { author ->
        val label = author.label.ifEmpty { "Unknown" }
        if (author.kind == "agent") "$label (agent)" else label
    }

    companion object {
        /** The Yjs stack every note is written with (D31). */
        const val ENGINE = "yjs14"
    }
}

/** Where the person was, from the screen's route pattern and its arguments (ids kept, no query string). */
object FeedbackWhere {
    private val ID = Regex("^[0-9A-HJKMNP-TV-Z]{26}$")

    /**
     * `note/{id}?new={new}…` with its arguments becomes `/note/01J…`: the path's arguments in
     * place, and an id passed in the query (a note's graph) added as a segment. Never a search
     * text or anything else from a query.
     */
    fun route(pattern: String?, args: (String) -> String?): String {
        pattern ?: return "/"
        val path = pattern.substringBefore('?')
        val filled = Regex("\\{([^}]+)}").replace(path) { match -> args(match.groupValues[1]).orEmpty() }
        val query = pattern.substringAfter('?', "")
        val ids = Regex("\\{([^}]+)}").findAll(query).mapNotNull { args(it.groupValues[1])?.takeIf(ID::matches) }.toList()
        return "/" + (listOf(filled.trim('/')) + ids).filter { it.isNotEmpty() }.joinToString("/")
    }

    /** The screen's name: the route's first word (`note`, `folder`, `settings`, `search` …). */
    fun screen(pattern: String?): String = pattern?.substringBefore('?')?.substringBefore('/')?.ifEmpty { null } ?: "unknown"
}

/**
 * The form's service (T49): what it opens on, its draft, and sending. Opening takes the context
 * and a `PixelCopy` of the window before the form is drawn, so both describe the screen behind
 * it (A801).
 */
class FeedbackService(
    val outbox: FeedbackOutbox,
    val drafts: FeedbackDrafts,
    val collector: FeedbackCollector,
    /** `filesDir/feedback/capture`: this opening's window capture. */
    private val captures: File,
    /** `<versionName> (build <versionCode>)`. */
    val version: String,
    private val scope: CoroutineScope,
) {
    /** What the form opened on: the context as it was, and the window's capture once written. */
    data class Opening(val context: FeedbackContextData, val capture: File? = null, val capturing: Boolean = false)

    private val _opening = MutableStateFlow<Opening?>(null)
    val opening: StateFlow<Opening?> = _opening.asStateFlow()

    private val busy = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Captures the screen behind and its context, then [show]s the form. A second tap while the
     * first is capturing does nothing.
     */
    fun open(where: WhereFacts, noteId: String?, extras: NoteExtras?, window: Window?, show: () -> Unit) {
        if (!busy.compareAndSet(false, true)) return
        scope.launch {
            try {
                // First the window, as it is: nothing of the form is drawn yet.
                // Never a git notebook's screen (A889): it shows the notebook's notes.
                val shot = window?.takeUnless { collector.gitNotebook }?.let { withTimeoutOrNull(CAPTURE_TIMEOUT_MS) { pixelCopy(it) } }
                val context = runCatching { collector.collect(where, noteId, extras) }.getOrElse { FeedbackContextData() }
                _opening.value = Opening(context, capturing = shot != null)
                show()
                if (shot != null) {
                    val file = withContext(Dispatchers.IO) { writeCapture(shot) }
                    _opening.update { it?.copy(capture = file, capturing = false) }
                }
            } finally {
                busy.set(false)
            }
        }
    }

    /** The form opened with nothing captured (after the app was restarted on it): the context now. */
    suspend fun reopen(where: WhereFacts) {
        if (_opening.value != null) return
        _opening.value = Opening(runCatching { collector.collect(where, null) }.getOrElse { FeedbackContextData() })
    }

    /** The form is closed: its capture goes unless the draft took it. */
    fun closed() {
        _opening.value = null
        captures.deleteRecursively()
    }

    private suspend fun pixelCopy(window: Window): Bitmap? = suspendCancellableCoroutine { continuation ->
        val view = window.decorView
        if (view.width <= 0 || view.height <= 0) {
            continuation.resume(null)
            return@suspendCancellableCoroutine
        }
        val bitmap = try {
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        } catch (error: OutOfMemoryError) {
            continuation.resume(null)
            return@suspendCancellableCoroutine
        }
        try {
            PixelCopy.request(window, bitmap, { result ->
                if (continuation.isActive) continuation.resume(if (result == PixelCopy.SUCCESS) bitmap else null)
            }, Handler(Looper.getMainLooper()))
        } catch (error: IllegalArgumentException) {
            // No surface yet (the window is not shown).
            continuation.resume(null)
        }
    }

    private fun writeCapture(bitmap: Bitmap): File? = try {
        captures.deleteRecursively()
        captures.mkdirs()
        val file = File(captures, "${UUID.randomUUID()}.png")
        file.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) throw IOException("not encoded") }
        bitmap.recycle()
        file
    } catch (error: IOException) {
        null
    }

    /**
     * Sends the form: its screenshots scaled and encoded into the outbox's folder, the
     * submission stored, the draft gone, then one attempt now. Throws [IOException] when a
     * screenshot cannot be read; nothing is stored then and the draft stays.
     */
    suspend fun send(draft: FeedbackDraft, context: FeedbackContextData): FeedbackOutbox.Outcome {
        val payload = FeedbackPayload.of(draft, version, context)
        val folder = outbox.folder(draft.submissionId)
        val names = withContext(Dispatchers.Default) {
            folder.deleteRecursively()
            try {
                draft.screenshots.take(FeedbackLimits.SCREENSHOTS).mapIndexed { index, image ->
                    FeedbackImages.prepare(drafts.image(image.file), image.mime, folder, index + 1).file.name
                }
            } catch (error: Exception) {
                folder.deleteRecursively()
                throw if (error is IOException) error else IOException("A screenshot could not be read", error)
            }
        }
        outbox.enqueue(draft.submissionId, payload, FeedbackValidation.title(draft.title), names)
        drafts.discard()
        return outbox.send(draft.submissionId)
    }

    /** What Edit came to. */
    enum class Edit {
        /** The form shows the report again; the outbox entry is gone. */
        OPENED,

        /** Another report is being written: one draft per phone, so the entry stays. */
        DRAFT_IN_THE_WAY,

        /** Sent or discarded meanwhile, or not readable: nothing changed. */
        GONE,
    }

    /**
     * Puts a report back in the form (Settings → About's Edit, T49 review): its type, priority,
     * title, description, screenshots and submission id, and the context it was captured with,
     * then [show]s the form. The outbox entry goes once the draft holds it, while no send can
     * take it. A refused report is never lost: it is filed, edited, or discarded.
     */
    suspend fun edit(id: String, show: () -> Unit): Edit {
        var outcome = Edit.GONE
        var context: FeedbackContextData? = null
        outbox.takeBack(id) { row, folder ->
            withContext(Dispatchers.IO) {
                val (form, captured) = FeedbackPayload.formOf(row.payload) ?: return@withContext false
                if (!drafts.load().blank) {
                    outcome = Edit.DRAFT_IN_THE_WAY
                    return@withContext false
                }
                val images = row.screenshots.split('\n').filter { it.isNotEmpty() }.mapNotNull { name ->
                    val mime = FeedbackImages.TYPES.entries.firstOrNull { it.value == name.substringAfterLast('.', "") }?.key ?: return@mapNotNull null
                    drafts.restoreImage(File(folder, name), mime)
                }
                drafts.save(form.copy(screenshots = images.take(FeedbackLimits.SCREENSHOTS)))
                context = captured
                outcome = Edit.OPENED
                true
            }
        }
        context?.let {
            _opening.value = Opening(it)
            show()
        }
        return outcome
    }

    /**
     * The cache was cleared (sign-out, another workspace): only a capture not yet in a form goes.
     * The draft and the outbox stay until they are sent or the person discards them (T49 review):
     * they are the person's words, not the account's cache, and go after the next sign-in.
     */
    fun clear() {
        captures.deleteRecursively()
    }

    companion object {
        const val CAPTURE_TIMEOUT_MS = 1_500L

        /** `0.31 (build 431425)`, as the footer and Settings → About say it. */
        fun version(name: String, code: Int) = "$name (build $code)"
    }
}

/** The app group's facts from the phone (T49, A791). */
object FeedbackAppFacts {
    fun of(context: Context, version: String, themeName: String, mode: String, dark: Boolean): AppFacts {
        val configuration = context.resources.configuration
        val density = context.resources.displayMetrics.density
        return AppFacts(
            version = version,
            os = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            webView = runCatching { WebViewCompat.getCurrentWebViewPackage(context)?.versionName }.getOrNull(),
            screen = screen(configuration.screenWidthDp, configuration.screenHeightDp, density),
            theme = "$themeName (${if (dark) "dark" else "light"})",
            appearance = mode,
            locale = Locale.getDefault().toLanguageTag(),
            timeZone = TimeZone.getDefault().id,
        )
    }

    /** `412×915 dp at 2.625×`. */
    fun screen(widthDp: Int, heightDp: Int, density: Float): String =
        "$widthDp×$heightDp dp at ${BigDecimal(density.toString()).stripTrailingZeros().toPlainString()}×"

    /** Whether the system shows dark now. */
    fun systemDark(context: Context): Boolean =
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
}

/** The activity a Compose context belongs to, for its window. */
fun Context.feedbackActivity(): Activity? {
    var current: Context? = this
    while (current is android.content.ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
