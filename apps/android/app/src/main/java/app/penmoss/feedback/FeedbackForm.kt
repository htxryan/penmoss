package app.penmoss.feedback

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/** One screenshot in a draft: its file in the draft's folder, its type, and whether it is the window's capture. */
@Serializable
data class DraftImage(val file: String, val mime: String, val capture: Boolean = false)

/**
 * An unsent form (T49, A796): kept on the phone until it is sent or discarded, so closing it by
 * accident loses nothing. Its [submissionId] is made once, with the draft, and names the
 * submission on every try.
 */
@Serializable
data class FeedbackDraft(
    val submissionId: String,
    val type: String? = null,
    val priority: Int? = null,
    val title: String = "",
    val description: String = "",
    val screenshots: List<DraftImage> = emptyList(),
    /** The context groups left out (their wire ids). */
    val omitted: List<String> = emptyList(),
) {
    /** Nothing typed, chosen or added: no draft worth keeping. */
    val blank: Boolean get() = type == null && priority == null && title.isBlank() && description.isBlank() && screenshots.isEmpty() && omitted.isEmpty()
}

/** What is missing or wrong in a form, field by field (T49): said under each field and read out. */
object FeedbackValidation {
    enum class Field { TYPE, PRIORITY, TITLE, DESCRIPTION }

    data class Problem(val field: Field, val message: String)

    /** The title as sent: one line, its spaces folded. */
    fun title(title: String): String = Js.trim(Js.collapseSpaces(title))

    fun problems(draft: FeedbackDraft): List<Problem> = buildList {
        if (FeedbackType.of(draft.type) == null) add(Problem(Field.TYPE, "Choose Bug report or Feature request."))
        if (draft.priority == null || draft.priority !in FeedbackPriority.all) add(Problem(Field.PRIORITY, "Choose a priority."))
        val title = title(draft.title)
        if (title.isEmpty()) add(Problem(Field.TITLE, "Give it a title."))
        if (title.length > FeedbackLimits.TITLE_MAX) add(Problem(Field.TITLE, "Keep the title to ${FeedbackLimits.TITLE_MAX} characters."))
        if (draft.description.length > FeedbackLimits.DESCRIPTION_MAX) add(Problem(Field.DESCRIPTION, "Keep the description to ${"%,d".format(java.util.Locale.US, FeedbackLimits.DESCRIPTION_MAX)} characters (it has ${"%,d".format(java.util.Locale.US, draft.description.length)})."))
    }

    /** One sentence for TalkBack naming everything to fix, or null when the form can be sent. */
    fun summary(problems: List<Problem>): String? =
        if (problems.isEmpty()) null else "Can’t send yet: ${problems.joinToString("; ") { it.message.trimEnd('.').replaceFirstChar(Char::lowercase) }}."
}

/** The `payload` part (A792): what is sent is the context the form previewed, without the groups left out. */
object FeedbackPayload {
    private val json = Json { encodeDefaults = true }

    fun of(draft: FeedbackDraft, version: String, context: FeedbackContextData): String {
        val type = requireNotNull(FeedbackType.of(draft.type)) { "no type" }
        val priority = requireNotNull(draft.priority) { "no priority" }
        return buildJsonObject {
            put("submissionId", draft.submissionId)
            put("type", type.wire)
            put("priority", JsonPrimitive(priority))
            put("title", FeedbackValidation.title(draft.title))
            put("description", draft.description)
            put("version", Js.trim(Js.collapseSpaces(version)).take(FeedbackLimits.VERSION_MAX))
            put("context", json.encodeToJsonElement(FeedbackContextData.serializer(), context.without(draft.omitted.toSet())))
        }.toString()
    }

    private val reader = Json { ignoreUnknownKeys = true }

    /**
     * A payload as the form it came from, for Edit (T49 review): its type, priority, title,
     * description and submission id, and the context it was sent with (the groups left out are
     * not in it). Null for one that is not a payload.
     */
    fun formOf(payload: String): Pair<FeedbackDraft, FeedbackContextData>? = try {
        val value = reader.parseToJsonElement(payload).jsonObject
        fun text(key: String) = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val draft = FeedbackDraft(
            submissionId = text("submissionId") ?: return null,
            type = text("type")?.takeIf { FeedbackType.of(it) != null },
            priority = (value["priority"] as? JsonPrimitive)?.intOrNull?.takeIf { it in FeedbackPriority.all },
            title = text("title").orEmpty(),
            description = text("description").orEmpty(),
        )
        val context = value["context"]?.let { reader.decodeFromJsonElement(FeedbackContextData.serializer(), it) } ?: FeedbackContextData()
        draft to context
    } catch (error: Exception) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        null
    }
}

/**
 * The draft on disk (T49, A796): `draft.json` and its screenshots in `filesDir/feedback/draft/`,
 * one draft per phone. Written whole on each change, through a temporary file.
 */
class FeedbackDrafts(private val dir: File, private val newId: () -> String) {
    private val file get() = File(dir, "draft.json")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The draft kept, or a new one with a new submission id. */
    @Synchronized
    fun load(): FeedbackDraft {
        val stored = try {
            if (file.isFile) json.decodeFromString(FeedbackDraft.serializer(), file.readText()) else null
        } catch (error: Exception) {
            null
        }
        // A screenshot whose file went (storage cleared) is dropped from the draft.
        return stored?.let { it.copy(screenshots = it.screenshots.filter { image -> image(image.file).isFile }) } ?: FeedbackDraft(newId())
    }

    @Synchronized
    fun save(draft: FeedbackDraft) {
        try {
            dir.mkdirs()
            val next = File(dir, "draft.json.tmp")
            next.writeText(json.encodeToString(FeedbackDraft.serializer(), draft))
            if (!next.renameTo(file)) {
                file.delete()
                next.renameTo(file)
            }
            // Files no screenshot names any more (removed, or replaced capture) go.
            val kept = draft.screenshots.map { it.file }.toSet() + setOf("draft.json", "draft.json.tmp")
            dir.listFiles()?.filter { it.name !in kept }?.forEach { it.delete() }
        } catch (error: IOException) {
            // A full disk loses the draft's last change, never the app.
        }
    }

    /** Sent or discarded: the draft and its screenshots go. */
    @Synchronized
    fun discard() {
        dir.deleteRecursively()
    }

    fun image(name: String): File = File(dir, name)

    /**
     * Copies a picked image into the draft, at most [FeedbackLimits.SCREENSHOT_BYTES]: null when
     * it is larger (nothing is kept).
     */
    fun addImage(source: InputStream, mime: String): DraftImage? {
        dir.mkdirs()
        val ext = FeedbackImages.TYPES[mime.lowercase()] ?: return null
        val target = File(dir, "${UUID.randomUUID()}.$ext")
        var total = 0L
        source.use { input ->
            target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > FeedbackLimits.SCREENSHOT_BYTES) {
                        output.close()
                        target.delete()
                        return null
                    }
                    output.write(buffer, 0, read)
                }
            }
        }
        if (total == 0L) {
            target.delete()
            return null
        }
        return DraftImage(target.name, mime.lowercase())
    }

    /** Copies a screenshot from an outbox entry taken back into the form (Edit): null when it cannot be read. */
    fun restoreImage(source: File, mime: String): DraftImage? {
        val ext = FeedbackImages.TYPES[mime] ?: return null
        if (!source.isFile) return null
        return try {
            dir.mkdirs()
            val target = File(dir, "${UUID.randomUUID()}.$ext")
            source.copyTo(target)
            DraftImage(target.name, mime)
        } catch (error: IOException) {
            null
        }
    }

    /** Takes the window's capture into the draft as its first screenshot. */
    fun adoptCapture(capture: File): DraftImage? {
        if (!capture.isFile) return null
        dir.mkdirs()
        val target = File(dir, "capture-${UUID.randomUUID()}.png")
        return try {
            capture.copyTo(target)
            DraftImage(target.name, "image/png", capture = true)
        } catch (error: IOException) {
            null
        }
    }
}
