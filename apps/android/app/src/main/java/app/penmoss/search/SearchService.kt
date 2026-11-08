package app.penmoss.search

import app.penmoss.data.NotebookScope
import app.penmoss.data.OfflineSearch
import app.penmoss.engine.api.SearchHit
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.SearchFilters
import app.penmoss.engine.api.SearchMode
import kotlinx.coroutines.CancellationException

/** One search: what was typed, the filters, and whether Enter asked for it now (A111). */
data class SearchRequest(
    val input: String,
    val filters: SearchFilters = SearchFilters(),
    val submitted: Boolean = false,
    val limit: Int = OfflineSearch.DEFAULT_LIMIT,
)

/** One result, from the server or the phone, marked with U+0002…U+0003. */
data class SearchResult(
    val id: String,
    val title: String,
    /** The title with its matched words marked; blank when nothing in it matched. */
    val titleMarked: String,
    val snippet: String,
    /** The section that matched (semantic results). */
    val heading: String? = null,
    val tags: List<String> = emptyList(),
    val updatedAt: Long = 0,
    /** Found by meaning (a semantic source), as the web's "≈". */
    val semantic: Boolean = false,
    /** The note's first line, for a note the phone has no text of yet (unmarked). */
    val excerpt: String = "",
)

data class SearchOutcome(
    val source: Source,
    val results: List<SearchResult>,
    /** The server's notice, shown as it says. */
    val notice: String? = null,
    /**
     * Why these results match words alone (T42, review S1): offline, or meaning could not
     * answer. Shown quietly, as "Words only" with this as its description.
     */
    val wordsOnly: String? = null,
    /** The phone answered while typing; the server answers on a pause (A111). */
    val preview: Boolean = false,
) {
    enum class Source { SERVER, DEVICE }
}

/**
 * Search for the phone (T40 P6, FD1–FD4), as the web's `SearchService`: one search, Hybrid
 * always (T42, A460, review S1). While typing, the phone's offline index answers at once, so no
 * request goes out per keystroke; on a pause or Enter, the server answers by words and meaning,
 * with the filters. When the server cannot answer (offline, or an error), the phone's full-text
 * results stand, marked "Words only", as they are when the server's meaning could not answer.
 */
class SearchService(
    private val api: PenmossApi,
    private val local: OfflineSearch,
    /** Whether a network is up; offline, the typing answer says it is words only. */
    private val online: () -> Boolean = { true },
    /** The notebooks open on this phone (T43, A752): what every search covers. */
    private val notebooks: suspend () -> NotebookScope = { NotebookScope.ALL },
    /** A note's folder as the phone has it, for a result an older server names no notebook for. */
    private val folderOf: suspend (String) -> String? = { null },
) {
    /** The answer while typing: the phone's full-text results. */
    suspend fun typing(request: SearchRequest): SearchOutcome {
        val offline = !online()
        return SearchOutcome(SearchOutcome.Source.DEVICE, device(request), preview = !offline, wordsOnly = if (offline) WORDS_ONLY_OFFLINE else null)
    }

    suspend fun search(request: SearchRequest): SearchOutcome {
        val scope = notebooks()
        try {
            val reply = api.search(
                request.input,
                request.limit,
                SearchMode.HYBRID,
                scope.open?.let { request.filters.copy(notebooks = it) } ?: request.filters,
                partial = !request.submitted && local.unfinished(request.input),
            )
            return SearchOutcome(
                SearchOutcome.Source.SERVER,
                reply.results.filter { open(it, scope) }.map {
                    SearchResult(
                        id = it.id,
                        title = it.title,
                        titleMarked = it.titleHighlighted.takeIf { marked -> MATCH_START in marked }.orEmpty(),
                        snippet = it.snippet,
                        heading = it.heading,
                        tags = it.tags,
                        updatedAt = it.updatedAt,
                        semantic = "semantic" in it.sources,
                    )
                },
                // A notice on a hybrid answer: meaning could not answer, so the words did (T42, lane t42-ui).
                notice = null,
                wordsOnly = reply.notice?.let(::wordsOnlyReason),
            )
        } catch (stale: CancellationException) {
            // The query changed: this answer must not replace the next one's (T39).
            throw stale
        } catch (_: Exception) {
            // Offline, or the server could not answer: the phone's own index answers.
        }
        return SearchOutcome(SearchOutcome.Source.DEVICE, device(request, scope), wordsOnly = WORDS_ONLY_OFFLINE)
    }

    /**
     * A result in a notebook open here (A752): as the server names it, or, from a server before
     * notebooks, by the folder the phone has the note in.
     */
    private suspend fun open(hit: SearchHit, scope: NotebookScope): Boolean {
        if (scope.closed.isEmpty()) return true
        hit.notebook?.let { return it.id !in scope.closed }
        return folderOf(hit.id)?.let { it !in scope.hiddenFolders } ?: true
    }

    private suspend fun device(request: SearchRequest, scope: NotebookScope? = null): List<SearchResult> =
        local.search(request.input, request.filters, request.limit, hidden = (scope ?: notebooks()).hiddenFolders).map {
            SearchResult(it.noteId, it.title, it.titleMarked, it.snippet, updatedAt = it.updatedAt, excerpt = it.excerpt)
        }

    companion object {
        /** The web's words in T42 (lane t42-ui, `apps/web/src/search/service.ts` there; recheck when it merges). */
        const val WORDS_ONLY = "Words only"
        const val WORDS_ONLY_OFFLINE = "Offline: matching by meaning needs a connection, so these results match your words."
        const val WORDS_ONLY_LIMIT = "Matching by meaning has used today’s allowance, so these results match your words."
        const val WORDS_ONLY_UNAVAILABLE = "Matching by meaning is unavailable right now, so these results match your words."

        /** Why a hybrid answer the server gave by words alone (its notice, A113), as the web says it. */
        fun wordsOnlyReason(serverNotice: String): String =
            if (Regex("allowance", RegexOption.IGNORE_CASE).containsMatchIn(serverNotice)) WORDS_ONLY_LIMIT else WORDS_ONLY_UNAVAILABLE
        private const val MATCH_START = "\u0002"

        /** The phone answers each keystroke at once (A111). */
        const val TYPING_MS = 60L

        /**
         * The server is asked after a pause in typing, or at once on Enter (A111): it embeds the
         * query. Offline, no wait: the phone's answer is the only one (review nit, as the web's).
         */
        fun pauseMs(online: Boolean): Long = if (online) 700L else TYPING_MS

        /**
         * How long the phone's preview waits for the server's answer before it shows (T53 item 2),
         * as the web's: the hybrid answer reorders it and adds notes found by meaning, so a preview
         * shown at once jumped a second later. Until one shows, the status line's spinner turns.
         */
        const val PREVIEW_HOLD_MS = 700L + 1_800L
    }
}
