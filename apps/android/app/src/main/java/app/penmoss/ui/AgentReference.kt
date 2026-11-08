package app.penmoss.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import app.penmoss.data.FolderEntity
import app.penmoss.data.Notebooks
import kotlinx.coroutines.flow.first

/**
 * Copy Agent Reference (T52 item 4): two lines of plain text that name a note so an agent finds
 * it through Penmoss's MCP server: its title and place (the notebook, then its folders), and the
 * read_note call that reads it, the only place the id appears (T53 item 7). The text is core's `agentReference`
 * (`packages/core/src/agent-reference.ts`), matched here case for case against
 * `contract/agent-reference-v1.json` by `AgentReferenceContractTest`.
 */
object AgentReference {
    /** What the snackbar says once the reference is on the clipboard. */
    const val COPIED = "Copied Agent Reference"

    /** Between the notebook and each folder. */
    private const val SEPARATOR = " › "

    /** JavaScript's `\s`, so a title collapses on every client alike (Java's `\s` is ASCII only). */
    private val SPACES = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    /** One line: every run of whitespace as one space, trimmed. */
    private fun oneLine(text: String): String = text.replace(SPACES, " ").trim(' ')

    /** Inside double quotes, backslashes and double quotes escaped as JSON escapes them. */
    private fun quoted(text: String): String = "\"" + oneLine(text).replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /**
     * The reference's text: two lines, no final line break. [notebook] is the notebook's name (the
     * default one's included); [folders] are the folders below it, outermost first; [gitNotebook]
     * names a git notebook, whose notes are read through its local MCP server instead.
     */
    fun text(id: String, title: String, notebook: String, folders: List<String>, gitNotebook: String? = null): String {
        val cleanId = oneLine(id)
        val name = oneLine(title).ifEmpty { "Untitled" }
        val place = (listOf(notebook) + folders).map(::oneLine).filter { it.isNotEmpty() }.joinToString(SEPARATOR)
        val call = "read_note {\"id\":\"$cleanId\"}"
        val how = if (gitNotebook == null) {
            "Read it with the Penmoss MCP tool $call"
        } else {
            "Read it with the git notebook’s local Penmoss MCP (penmoss mcp --notebook ${quoted(gitNotebook)}) tool $call"
        }
        return "Penmoss note ${quoted(name)}${if (place.isEmpty()) "" else " ($place)"}\n$how"
    }

    /**
     * A note's reference from what the phone holds: its folder in [folders] (null at the top level)
     * gives its notebook and the folders below it. A note in no notebook is in the default one,
     * [defaultNotebook]; in a git notebook ([gitNotebook]) that notebook's name stands for both.
     */
    fun of(
        id: String,
        title: String,
        folderId: String?,
        folders: List<FolderEntity>,
        defaultNotebook: String,
        gitNotebook: String? = null,
    ): String {
        val byId = folders.associateBy { it.id }
        val chain = ArrayList<FolderEntity>()
        val seen = HashSet<String>()
        var at = folderId
        while (at != null && seen.add(at)) {
            val folder = byId[at] ?: break
            chain += folder
            at = folder.parentId
        }
        chain.reverse()
        if (gitNotebook != null) return text(id, title, gitNotebook, chain.map { it.name }, gitNotebook)
        val notebookId = Notebooks.index(folders).ofFolder(folderId)
        val notebookAt = chain.indexOfFirst { it.id == notebookId }
        return if (notebookId != null && notebookAt >= 0) {
            text(id, title, chain[notebookAt].name, chain.drop(notebookAt + 1).map { it.name })
        } else {
            text(id, title, defaultNotebook, chain.map { it.name })
        }
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
 * Trash (T52 item 4). [gitNotebook] names the git notebook [store] is, if it is one.
 */
internal suspend fun agentReferenceOf(store: app.penmoss.data.NoteStore, noteId: String, gitNotebook: String? = null): String? {
    val note = store.note(noteId)?.takeUnless { it.deleted } ?: return null
    return AgentReference.of(note.id, note.title, note.folderId, store.observeFolders().first(), store.defaultNotebookName(), gitNotebook)
}
