package app.penmoss.search

import java.text.Normalizer

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
        SearchAction("app.gitNotebooks", "Notebooks"),
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
 * The web palette's fuzzy match, which is core's (`packages/core/src/fuzzy.ts`, `fuzzyMatch` with
 * `scattered: false`): every query character in order, ignoring case and accents; word starts,
 * runs and a prefix or contained match score higher, an exact title highest, gaps and long titles
 * lower; letters scattered across a long title are no match.
 */
internal object Fuzzy {
    private const val BOUNDARY = "-_/.,:;()[]{}'\"#|"
    private val MARKS = Regex("[\\u0300-\\u036f]")

    /** Lower case without accents. */
    private fun fold(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFD).replace(MARKS, "").lowercase()

    private fun isBoundary(text: String, index: Int): Boolean =
        index == 0 || text[index - 1].let { it.isWhitespace() || it in BOUNDARY }

    fun score(query: String, text: String): Double? {
        val q = fold(query.trim())
        val t = fold(text)
        if (q.isEmpty()) return 0.0
        if (t == q) return 1000.0
        // UTF-16 units, where core's `[...q]` walks code points: the two differ only for an
        // astral character (an emoji) in the query, which no action title holds (review nit).
        val chars = q.filter { it != ' ' }
        var score = 0.0
        var from = 0
        var previous = -2
        var first = -1
        var last = -1
        for ((n, char) in chars.withIndex()) {
            var at = t.indexOf(char, from)
            if (at == -1) return null
            // Greedy, preferring word starts: a later word start holding the character, when
            // the rest still matches after it.
            if (at != previous + 1) {
                var i = t.indexOf(char, at + 1)
                while (i != -1) {
                    if (isBoundary(t, i) && !isBoundary(t, at) && isSubsequence(chars, n + 1, t, i + 1)) {
                        at = i
                        break
                    }
                    i = t.indexOf(char, i + 1)
                }
            }
            if (at == previous + 1) score += 6.0
            if (isBoundary(t, at)) score += 8.0
            if (at == 0) score += 10.0
            score -= minOf(at - from, 10) * 0.5
            if (first == -1) first = at
            last = at
            previous = at
            from = at + 1
        }
        val contained = t.contains(q)
        if (!contained && last - first > chars.length * 3 + 4) return null
        if (t.startsWith(q)) score += 40.0 else if (contained) score += 20.0
        // Shorter titles win ties: the match covers more of them.
        return score - t.length * 0.05
    }

    private fun isSubsequence(chars: String, from: Int, text: String, at: Int): Boolean {
        var position = at
        for (i in from until chars.length) {
            position = text.indexOf(chars[i], position)
            if (position == -1) return false
            position++
        }
        return true
    }
}
