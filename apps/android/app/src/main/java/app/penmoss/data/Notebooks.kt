package app.penmoss.data

/**
 * Notebooks on the phone (T43, A750–A756), read from the folders in Room as core's
 * `workspace/notebooks.ts` reads the WorkspaceDoc: a notebook is a top-level folder flagged
 * `notebook`, and a note or folder belongs to the outermost flagged folder above it (or to itself,
 * for a notebook's own folder). Everything else is the default notebook ([DEFAULT]). Reading never
 * writes a repair, as the folder tree's rules (A17).
 */
object Notebooks {
    /** The default notebook's id wherever a notebook is named by id (`notebooks=`, targets). */
    const val DEFAULT = "default"

    /** The setting the phone keeps the default notebook's name in (NoteStore). */
    const val NAME_SETTING = "defaultNotebook"

    /** The default notebook's name until the person names it (A751). */
    const val DEFAULT_NAME = "Personal"

    /** core's `journalFolderId('Journal')`: the same id on every device. */
    const val JOURNAL_FOLDER = "0000000000S8E1TX8VKMHGWYHE"

    /** core's `journalFolderId('Inbox')`. */
    const val INBOX_FOLDER = "0000000000ER2EH9S3C9F6Z509"

    /** What [moveRefusal] and [flagRefusal] say, in core's words (the server's 422 `notebook_rule`). */
    const val STAYS_AT_TOP = "A notebook stays at the top level: notebooks cannot go inside folders"
    const val JOURNAL_STAYS = "Journal and the Inbox stay in the default notebook"
    const val ONLY_TOP_LEVEL = "Only a top-level folder can be a notebook"

    /** The default notebook's name as shown: what the person named it, or "Personal". */
    fun defaultName(name: String?): String = name?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_NAME

    fun index(folders: List<FolderEntity>): NotebookIndex = NotebookIndex(folders)

    /** True for the Journal folder and the Inbox: they stay in the default notebook (A751). */
    fun isJournalOrInbox(folder: FolderEntity): Boolean =
        folder.id == JOURNAL_FOLDER || folder.id == INBOX_FOLDER ||
            (folder.parentId == null && folder.name.trim().lowercase() == "inbox")

    /** The folder is Journal or the Inbox, or holds one of them. */
    fun holdsJournal(folders: List<FolderEntity>, folderId: String): Boolean {
        val byId = folders.associateBy { it.id }
        return folders.any { candidate ->
            if (!isJournalOrInbox(candidate)) return@any false
            var at: String? = candidate.id
            val seen = HashSet<String>()
            while (at != null && seen.add(at)) {
                if (at == folderId) return@any true
                at = byId[at]?.parentId
            }
            false
        }
    }

    /**
     * The folder is in Journal or the Inbox at any depth (Journal/2026, say), or is one of them
     * (T43 review S4, core's `inJournal`): a cycle stops where it repeats.
     */
    fun inJournal(folders: List<FolderEntity>, folderId: String): Boolean {
        val byId = folders.associateBy { it.id }
        val seen = HashSet<String>()
        var at: String? = folderId
        while (at != null && seen.add(at)) {
            val folder = byId[at] ?: return false
            if (isJournalOrInbox(folder)) return true
            at = folder.parentId
        }
        return false
    }

    /**
     * The folder stays in the default notebook (A751, T43 review S4): it is Journal or the Inbox,
     * holds one of them, or is inside one at any depth. Daily notes and captures file there.
     */
    fun staysInDefault(folders: List<FolderEntity>, folderId: String): Boolean =
        holdsJournal(folders, folderId) || inJournal(folders, folderId)

    /**
     * Why a folder cannot move to [parentId], or null when it can (A750): a notebook stays at
     * the top level, and Journal and the Inbox, the folders holding them and everything in them
     * ([staysInDefault]) never go into a notebook. Whether the move would loop is the tree's own
     * check.
     */
    fun moveRefusal(folders: List<FolderEntity>, folderId: String, parentId: String?): String? {
        val folder = folders.firstOrNull { it.id == folderId } ?: return null
        if (folder.notebook && parentId != null) return STAYS_AT_TOP
        if (parentId != null && index(folders).ofFolder(parentId) != null && staysInDefault(folders, folderId)) return JOURNAL_STAYS
        return null
    }

    /** Why a folder cannot be turned into a notebook ([on]) or back into a folder, or null. */
    fun flagRefusal(folders: List<FolderEntity>, folderId: String, on: Boolean): String? {
        val folder = folders.firstOrNull { it.id == folderId } ?: return "No such folder"
        if (!on) return if (folder.notebook) null else "That folder is not a notebook"
        if (folder.notebook) return null
        if (folder.parentId != null) return ONLY_TOP_LEVEL
        if (holdsJournal(folders, folderId)) return JOURNAL_STAYS
        return null
    }

    /** The folders whose notes the lists leave out (A752): every folder of a notebook in [closed]. */
    fun hiddenFolders(folders: List<FolderEntity>, closed: Set<String>): Set<String> {
        if (closed.isEmpty()) return emptySet()
        val index = index(folders)
        return folders.mapNotNullTo(HashSet()) { folder -> folder.id.takeIf { index.ofFolder(it) in closed } }
    }

    /** What search and its offline index need to leave closed notebooks out (A752). */
    fun scope(folders: List<FolderEntity>, closed: Set<String>): NotebookScope {
        val index = index(folders)
        val shut = closed.filterTo(HashSet()) { index.isNotebook(it) }
        if (shut.isEmpty()) return NotebookScope.ALL
        val open = listOf(DEFAULT) + index.notebooks.map { it.id }.filter { it !in shut }
        return NotebookScope(open, shut, hiddenFolders(folders, shut))
    }
}

/**
 * Which notebooks a search covers (T43, A752): [open] is sent as `notebooks=` (null: every one,
 * nothing sent), [closed] leaves out a result the server names in one, and [hiddenFolders] one
 * filed in their folders (the offline index, and an older server's results).
 */
data class NotebookScope(val open: List<String>?, val closed: Set<String>, val hiddenFolders: Set<String>) {
    companion object {
        val ALL = NotebookScope(null, emptySet(), emptySet())
    }
}

/** Which notebook each folder is in, worked out once for a snapshot of the folders. */
class NotebookIndex(folders: List<FolderEntity>) {
    private val parents: Map<String, String?> = folders.associate { it.id to it.parentId }
    private val flagged: Set<String> = folders.filter { it.notebook }.mapTo(HashSet()) { it.id }
    private val memo = HashMap<String, String?>()

    /** The notebooks, in the top level's manual order (position, then id), as core lists them. */
    val notebooks: List<FolderEntity> = folders
        .filter { it.id in flagged && outermost(it.id) == it.id }
        .sortedWith { a, b -> a.position.compareTo(b.position).takeIf { it != 0 } ?: a.id.compareTo(b.id) }

    private val own: Set<String> = notebooks.mapTo(HashSet()) { it.id }

    /** The notebook a folder is in (its own id for a notebook's folder); null: the default. */
    fun ofFolder(folderId: String?): String? =
        if (folderId == null || !parents.containsKey(folderId)) null else outermost(folderId)

    /** True when the folder is a notebook's own folder. */
    fun isNotebook(folderId: String?): Boolean = folderId != null && folderId in own

    /** The outermost flagged folder on the way up; a cycle stops where it repeats. */
    private fun outermost(folderId: String): String? {
        if (memo.containsKey(folderId)) return memo[folderId]
        val chain = ArrayList<String>()
        val seen = HashSet<String>()
        var at: String? = folderId
        while (at != null && parents.containsKey(at) && seen.add(at)) {
            chain += at
            at = parents[at]
        }
        // From the top down: the first flagged folder met is the outermost.
        var found: String? = null
        for (id in chain.asReversed()) {
            if (found == null && id in flagged) found = id
            memo[id] = found
        }
        return memo[folderId]
    }
}
