package app.penmoss.ui

/**
 * Short note references (PEN-69): `<notebook>-<note>`, e.g. `K7QD-9HTF2CXA`. The notebook part is
 * 4 Crockford base32 characters of a 32-bit FNV-1a hash of the notebook's id (`notebook.json`),
 * the note part the last 8 characters of its ULID; when an older note of the notebook ends the
 * same way, the reference holds the whole ULID instead. A port of core's `note-ref.ts`, matched
 * against `contract/agent-reference-v1.json` by `AgentReferenceContractTest`.
 */
object NoteRef {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val ULID = Regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$")

    /** How many of a note id's last characters a short reference keeps. */
    const val NOTE_LENGTH = 8

    /** The 4 characters that name a notebook in its notes' short references. */
    fun notebookTag(notebookId: String): String {
        var hash = 0x811c9dc5.toInt()
        for (char in notebookId.trim()) {
            hash = (hash xor char.code) * 0x01000193
        }
        return buildString { for (i in 0 until 4) append(ALPHABET[(hash ushr (27 - i * 5)) and 31]) }
    }

    /**
     * [noteId]'s short reference in the notebook [notebookId]; [others] are the notebook's note ids
     * that may end as it does (its own may be among them). A note id that is not a ULID is its own.
     */
    fun shortRef(notebookId: String, noteId: String, others: Collection<String> = emptyList()): String {
        val id = noteId.trim()
        if (!ULID.matches(id)) return id
        val end = id.takeLast(NOTE_LENGTH)
        val clash = others.any { it != id && it < id && ULID.matches(it) && it.endsWith(end) }
        return "${notebookTag(notebookId)}-${if (clash) id else end}"
    }
}
