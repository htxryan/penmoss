package app.penmoss.ui.note

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

/**
 * Copy Agent Reference (T52 item 4; shortened by PEN-69; version 3 in PEN-155): one line of plain
 * text that names a note so an agent reads it through Penmoss's MCP server, the one `penmoss mcp`
 * for every notebook: the read_note call with the note's short reference ([NoteRef]), whose first
 * 4 characters find its notebook. The text is core's `agentReference` (`packages/core/src/agent-reference.ts`),
 * matched here case for case against `contract/agent-reference-v1.json` by
 * `AgentReferenceContractTest`.
 */
object AgentReference {
    /** What the snackbar says once the reference is on the clipboard. */
    const val COPIED = "Copied Agent Reference"

    /** JavaScript's `\s`, so an id collapses on every client alike (Java's `\s` is ASCII only). */
    private val SPACES = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    /** One line: every run of whitespace as one space, trimmed. */
    private fun oneLine(text: String): String = text.replace(SPACES, " ").trim(' ')

    /**
     * The reference's text: one line. With [notebookId] (its git notebook's `notebook.json` id) the
     * note is named by its short reference, else by its id. [noteIds] are the notebook's notes that
     * may end as this one does.
     */
    fun text(
        id: String,
        notebookId: String? = null,
        noteIds: Collection<String> = emptyList(),
    ): String {
        val cleanId = oneLine(id)
        val ref = if (notebookId.isNullOrBlank()) cleanId else NoteRef.shortRef(notebookId, cleanId, noteIds)
        return "Reference note via Penmoss MCP tool read_note {\"id\":\"$ref\"}"
    }

    /** Puts [reference] on the clipboard as plain text; returns what to say ([COPIED], or why not). */
    fun copy(context: Context, reference: String, set: ((ClipData) -> Unit)? = null): String {
        val write = set ?: context.getSystemService(ClipboardManager::class.java)?.let { it::setPrimaryClip }
            ?: return "Copying wasn't allowed here"
        return if (runCatching { write(ClipData.newPlainText("Penmoss", reference)) }.isSuccess) COPIED else "Copying wasn't allowed here"
    }
}

/**
 * [noteId]'s reference from what [store] holds, or null when the note is not on the phone or is in
 * Trash (T52 item 4). [notebookId] is the `notebook.json` id of the git notebook [store] is, if it
 * is one, which gives the note its short id (PEN-69).
 */
internal suspend fun agentReferenceOf(
    store: app.penmoss.data.NoteStore,
    noteId: String,
    notebookId: String? = null,
): String? {
    val note = store.note(noteId)?.takeUnless { it.deleted } ?: return null
    val others = if (notebookId == null) emptyList() else store.idsEndingWith(note.id.takeLast(NoteRef.NOTE_LENGTH))
    return AgentReference.text(note.id, notebookId, others)
}

/** [noteId]'s reference in [graph] (its git notebook's, when it is one). */
internal suspend fun agentReferenceIn(graph: app.penmoss.NotebookGraph, noteId: String): String? {
    return agentReferenceOf(graph.store, noteId, graph.notebookId)
}
