package app.penmoss.search

/**
 * One action Search can run (T40 P6, FD6, A466): a web command's id and title, from
 * `apps/android/contract/commands-v1.json`, whose `{"search": true}` entries are exactly these
 * (`SearchActionsTest`). What each does is the app's ([app.penmoss.ui.runSearchAction]).
 */
data class SearchAction(val id: String, val title: String)

/** Search's Actions section (FD6): the web palette's commands a phone runs from Search. */
object SearchActions {
    /** In the registry's order, which the ranking keeps for equal scores (as the palette's sort). */
    val ALL: List<SearchAction> = listOf(
        SearchAction("app.cheatsheet", "Keyboard Shortcuts"),
        SearchAction("app.settings", "Settings"),
        SearchAction("app.shortcuts", "Customise Keyboard Shortcuts"),
        // Git notebooks (T50 G7, A856): Settings → Git notebooks, as on the Mac.
        SearchAction("app.gitNotebooks", "Git Notebooks"),
        // Feedback still on the phone and the GitHub token: Settings → About (T59, A1046).
        SearchAction("app.status", "Feedback Status and GitHub Token"),
        // In-app feedback (T49, D41): the same form as the overflow menu's, captured first.
        SearchAction("app.sendFeedback", "Send Feedback"),
        SearchAction("app.home", "Close the Note"),
        SearchAction("app.graph", "Graph"),
        SearchAction("note.new", "New Note"),
        SearchAction("app.capture", "Quick Capture…"),
        SearchAction("app.trash", "Trash"),
        SearchAction("journal.today", "Today's Note"),
        SearchAction("journal.thisWeek", "This Week's Note"),
        SearchAction("journal.calendar", "Show the Calendar"),
        SearchAction("journal.settings", "Time Zone and Templates"),
        SearchAction("folder.new", "New Folder"),
        SearchAction("app.appearance", "Appearance and Themes"),
        SearchAction("app.display", "Sidebar Display Settings"),
        SearchAction("app.symbols", "Edit Line Symbols"),
        SearchAction("theme.switch", "Switch Theme…"),
        SearchAction("theme.toggleDark", "Toggle Dark Mode"),
    )

    /** At most this many above the notes while typing (the palette's limit is 40 for both). */
    const val SHOWN = 5

    /** The actions [query] finds, best first, as the web palette ranks commands; none for a blank query. */
    fun matching(query: String, actions: List<SearchAction> = ALL): List<SearchAction> {
        if (query.isBlank()) return emptyList()
        return actions.mapNotNull { action -> Fuzzy.score(query, action.title)?.let { action to it } }
            .sortedByDescending { it.second }
            .map { it.first }
    }
}

/**
 * The web palette's fuzzy match (`apps/web/src/commands/fuzzy.ts`, T20): every query character
 * in order; runs, word starts and a contiguous or prefix match score higher, long titles and
 * late starts lower; scattered letters across a long title are no match.
 */
internal object Fuzzy {
    private const val WORD_BREAK = " \t\n\r\u000B\u000C-—–/:·(.,_#["

    fun score(query: String, text: String): Double? {
        val q = query.lowercase().trim()
        if (q.isEmpty()) return 0.0
        val t = text.lowercase()
        var from = 0
        var score = 0.0
        var previous = -2
        val indices = ArrayList<Int>()
        // UTF-16 units, where the web's `for…of` walks code points: the two differ only for an
        // astral character (an emoji) in the query, which no action title holds (review nit).
        for (char in q) {
            if (char == ' ') continue
            val found = t.indexOf(char, from)
            if (found < 0) return null
            indices += found
            score += 1
            if (found == previous + 1) score += 3
            if (found == 0 || t[found - 1].let { it in WORD_BREAK || it.isWhitespace() }) score += 4
            previous = found
            from = found + 1
        }
        val contiguous = t.contains(q)
        val spread = indices.last() - indices.first()
        if (!contiguous && spread > q.replace(Regex("\\s"), "").length * 3 + 4) return null
        if (contiguous) score += 12
        if (t.startsWith(q)) score += 6
        return score - t.length * 0.02 - indices.first() * 0.05
    }
}
