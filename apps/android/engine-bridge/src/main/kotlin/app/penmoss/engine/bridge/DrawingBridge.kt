package app.penmoss.engine.bridge

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put

/*
 * Drawings (PEN-189; PEN-28, A1369): the bridge messages for the drawing editor. The page opens
 * Excalidraw over the note and says so ([DrawingFromEditor.Shown]); the note screen then shows its
 * drawing bar, whose Done and Cancel come back as [DrawingToEditor.Finish]. A drawing being edited
 * asks for its scene file ([DrawingFromEditor.SceneWanted]), which the WebView never serves; the
 * finished files reach the app as any file does (`file`, then `fileStored`). The page's side is in
 * `apps/android/editor/src/protocol.ts`; `bridge-v1.json` holds an example of each.
 */

/** The drawing bar's buttons. The back gesture is Done, as the Mac's Back keeps the drawing. */
enum class DrawingAction(val wire: String) {
    DONE("done"),
    CANCEL("cancel"),
    ;

    companion object {
        fun of(wire: String?): DrawingAction? = entries.firstOrNull { it.wire == wire }
    }
}

sealed interface DrawingToEditor : ToEditor {
    /** The drawing bar's Done or Cancel, for the drawing open now. */
    data class Finish(val action: DrawingAction) : DrawingToEditor

    /** The answer to [DrawingFromEditor.SceneWanted]: the scene's text, or null when the phone lacks it. */
    data class Scene(val noteId: String, val path: String, val text: String?) : DrawingToEditor
}

sealed interface DrawingFromEditor : FromEditor {
    /**
     * The drawing editor open over the note with this title, Done being saved while [saving] (the
     * bar's buttons wait); or closed (a null title), having kept a drawing when [kept].
     */
    data class Shown(val title: String?, val saving: Boolean = false, val kept: Boolean = false) : DrawingFromEditor

    /** A drawing's `.excalidraw` file, to open it in the drawing editor. */
    data class SceneWanted(val noteId: String, val path: String) : DrawingFromEditor
}

object DrawingBridge {
    /** A drawing's scene file: `attachments/<sha256>.excalidraw`. */
    val SCENE_PATH = Regex("^attachments/[0-9a-f]{64}\\.excalidraw$")

    /** The longest title the drawing bar shows ("Edit Excalidraw Diagram" is 23). */
    const val MAX_TITLE = 100

    fun encode(builder: JsonObjectBuilder, message: DrawingToEditor) = with(builder) {
        when (message) {
            is DrawingToEditor.Finish -> {
                put("type", "drawing")
                put("action", message.action.wire)
            }
            is DrawingToEditor.Scene -> {
                put("type", "drawingScene")
                put("noteId", message.noteId)
                put("path", message.path)
                put("text", message.text)
            }
        }
    }

    fun encode(builder: JsonObjectBuilder, message: DrawingFromEditor) = with(builder) {
        when (message) {
            is DrawingFromEditor.Shown -> {
                put("type", "drawing")
                put("title", message.title)
                if (message.title != null) put("saving", message.saving) else put("kept", message.kept)
            }
            is DrawingFromEditor.SceneWanted -> {
                put("type", "drawingScene")
                put("noteId", message.noteId)
                put("path", message.path)
            }
        }
    }

    /** `drawing` from the app, which names no note. */
    fun decodeFinish(value: JsonObject): DrawingToEditor? =
        DrawingAction.of(value.string("action"))?.let(DrawingToEditor::Finish)

    /** `drawing` from the page, which names no note: a title and `saving`, or null and `kept` once it closed. */
    fun decodeShown(value: JsonObject): DrawingFromEditor? = when (val raw = value["title"]) {
        is JsonNull -> DrawingFromEditor.Shown(null, kept = value.flag("kept") ?: return null)
        is JsonPrimitive -> raw.takeIf { it.isString }?.content
            ?.takeIf { it.isNotBlank() && it.length <= MAX_TITLE }
            ?.let { DrawingFromEditor.Shown(it, saving = value.flag("saving") ?: return null) }
        else -> null
    }

    fun decodeToEditor(type: String?, noteId: String, value: JsonObject): DrawingToEditor? = when (type) {
        "drawingScene" -> DrawingToEditor.Scene(
            noteId,
            value.string("path")?.takeIf(SCENE_PATH::matches) ?: return null,
            when (val raw = value["text"]) {
                is JsonNull -> null
                is JsonPrimitive -> raw.takeIf { it.isString }?.content ?: return null
                else -> return null
            },
        )
        else -> null
    }

    fun decodeFromEditor(type: String?, noteId: String, value: JsonObject): DrawingFromEditor? = when (type) {
        "drawingScene" -> DrawingFromEditor.SceneWanted(
            noteId,
            value.string("path")?.takeIf(SCENE_PATH::matches) ?: return null,
        )
        else -> null
    }

    private fun JsonObject.flag(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
