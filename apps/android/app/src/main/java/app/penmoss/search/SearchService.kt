package app.penmoss.search

import app.penmoss.data.OfflineSearch
import app.penmoss.engine.api.SearchFilters

/** One search: what was typed, the filters, and the most results to show. */
data class SearchRequest(
    val input: String,
    val filters: SearchFilters = SearchFilters(),
    val limit: Int = OfflineSearch.DEFAULT_LIMIT,
)

/** One result, its matched words marked with U+0002…U+0003. */
data class SearchResult(
    val id: String,
    val title: String,
    /** The title with its matched words marked; blank when nothing in it matched. */
    val titleMarked: String,
    val snippet: String,
    val tags: List<String> = emptyList(),
    val updatedAt: Long = 0,
    /** The note's first line, for a note the phone has no text of yet (unmarked). */
    val excerpt: String = "",
)

/**
 * Search on the phone (T40 P6, FD1–FD4): the phone's own index answers every search, offline too,
 * with the filters. It is the same keyword search as the notebook page's, held to the same order
 * (A462), so the page is never asked as well, and nothing is matched by meaning: a git notebook
 * searches words only (A101). A note whose text the phone has not fetched yet is found by its
 * title and first line.
 */
class SearchService(private val local: OfflineSearch) {
    suspend fun search(request: SearchRequest): List<SearchResult> =
        local.search(request.input, request.filters, request.limit).map {
            SearchResult(it.noteId, it.title, it.titleMarked, it.snippet, updatedAt = it.updatedAt, excerpt = it.excerpt)
        }

    companion object {
        /** A pause in typing this long, and the phone answers (A111): one search per burst of keys. */
        const val TYPING_MS = 60L
    }
}
