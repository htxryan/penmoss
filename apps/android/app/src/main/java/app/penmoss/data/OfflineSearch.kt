package app.penmoss.data

import androidx.sqlite.db.SimpleSQLiteQuery
import app.penmoss.engine.api.SearchFilters
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import kotlin.math.ln
import kotlin.math.max

/**
 * Full-text search on the phone (T40 P6, FD4): the offline index (`note_text_fts`, FTS4) read
 * the way the server reads a query (`@penmoss/core/search`'s `parseQuery`): words and
 * `"quoted phrases"` that must all match, `prefix*`, `-word` to leave notes out, `title:word`
 * for titles only, and (as you type) the last word as a prefix. Text and queries are folded as
 * the server's tokenizer folds them ([SearchFold], review B1). Ranked as the web's offline index
 * ranks (`LocalSearchIndex`, A101): bm25 over each clause's count weighted by column (title 10,
 * body 1, tags 5, headings 4), its idf from how many notes it matches, and each note's length
 * against the average; `search-ranking-v1.json` holds the two to the same order (A462).
 * Filters: a folder with its subfolders, a tag with the tags under it, and an updated-after
 * time, all from Room.
 *
 * A prefix of three letters or more is completed first (#120, A680, [SearchCompletions]) from
 * the notes' words as written (`note_word_terms`, over [NoteWordFts]): `happin` also matches
 * `happi`, the stem of happiness. Each completion is ORed with the prefix and ranks as a phrase
 * of its own, as the server's FTS5 ranks the same OR. FTS4's standard query syntax binds OR
 * tighter than the space between clauses, so `"a" "b*" OR "c"` is a AND (b* OR c).
 */
class OfflineSearch(
    private val db: PenmossDatabase,
    /**
     * Where a search folds, ranks and marks (A610): never the caller's thread, which is Main
     * for each pause in typing.
     */
    private val work: CoroutineContext = Dispatchers.Default,
) {
    private val dao = db.search()

    /** One answer: the note, its title and snippet marked with U+0002…U+0003 (blank when unmarked). */
    data class Hit(
        val noteId: String,
        val title: String,
        val titleMarked: String,
        val snippet: String,
        val excerpt: String,
        val updatedAt: Long,
        /** bm25, higher is better; 0 for a note found by its title and first line only. */
        val score: Double = 0.0,
    )

    /** [hidden]: the folders of notebooks closed on this phone, whose notes are left out (T43, A752). */
    suspend fun search(
        input: String,
        filters: SearchFilters = SearchFilters(),
        limit: Int = DEFAULT_LIMIT,
        prefixLast: Boolean = true,
        hidden: Set<String> = emptySet(),
    ): List<Hit> = withContext(work) { searchHere(input, filters, limit, prefixLast, hidden) }

    private suspend fun searchHere(input: String, filters: SearchFilters, limit: Int, prefixLast: Boolean, hidden: Set<String>): List<Hit> {
        val query = complete(Query.parse(input, prefixLast))
        val wanted = query.clauses.filter { !it.negated }
        if (wanted.isEmpty()) return emptyList()
        // What bm25 scores: each clause, and each completion on its own (A680).
        val units = wanted.flatMap(Query::units)
        val match = wanted.joinToString(" ", transform = Query::match)
        val folderIds = filters.folderId?.let { folderSubtree(it) }
        val where = StringBuilder()
        val args = mutableListOf<Any>(match)
        filterSql(filters, folderIds, where, args, hidden)
        val rows = try {
            dao.matches(
                SimpleSQLiteQuery(
                    "SELECT t.noteId AS noteId, matchinfo(note_text_fts, 'pcx') AS info, t.tokens AS tokens, n.title AS title, n.updatedAt AS updatedAt " +
                        "FROM note_text_fts JOIN note_texts t ON t.rowid = note_text_fts.rowid JOIN notes n ON n.id = t.noteId " +
                        "WHERE note_text_fts MATCH ? AND n.deleted = 0 AND n.gone = 0$where",
                    args.toTypedArray(),
                ),
            )
        } catch (malformed: android.database.sqlite.SQLiteException) {
            // A query FTS4 cannot read (it should never be one: every token is quoted).
            return emptyList()
        }
        val excluded = query.exclusions().flatMap { idsMatching(it) }.toSet()
        val kept = rows.filter { it.noteId !in excluded }
        val hits = if (kept.isEmpty()) emptyList() else rank(kept, units, match, limit)
        if (hits.size >= limit) return hits
        // Notes the index has no text for yet (not fetched): their titles and first lines, as before.
        return hits + unindexed(input, filters, folderIds, limit - hits.size, hits.map { it.noteId }.toSet(), hidden)
    }

    /**
     * The web index's bm25 (`LocalSearchIndex.search`): per unit (a clause, or a completion), its
     * idf (from the live notes it matches, whatever the filters) and its column-weighted count in
     * the note, saturated against the note's length; best first, then by id. Then the shown notes'
     * marks.
     */
    private suspend fun rank(rows: List<FtsMatchRow>, units: List<Query.Unit>, match: String, limit: Int): List<Hit> {
        val stats = dao.stats()
        val n = stats.notes.toDouble().coerceAtLeast(1.0)
        val average = (stats.tokens.toDouble() / n).takeIf { it > 0 } ?: 1.0
        val idf = units.map { unit ->
            val count = dao.count(
                SimpleSQLiteQuery(
                    "SELECT COUNT(*) FROM note_text_fts JOIN note_texts t ON t.rowid = note_text_fts.rowid JOIN notes n ON n.id = t.noteId " +
                        "WHERE note_text_fts MATCH ? AND n.deleted = 0 AND n.gone = 0",
                    arrayOf(unit.phrases.joinToString(" ")),
                ),
            ).toDouble()
            ln((0.5 + n - count) / (0.5 + count)).let { if (it <= 0) MIN_IDF else it }
        }
        val ranked = rows.map { row -> row to score(row, units, idf, average) }
            .sortedWith(compareByDescending<Pair<FtsMatchRow, Double>> { it.second }.thenBy { it.first.noteId })
            .take(limit)
        val marks = marks(match, ranked.map { it.first.noteId })
        return ranked.map { (row, score) ->
            val marked = marks[row.noteId]
            Hit(row.noteId, row.title, marked?.first.orEmpty(), marked?.second.orEmpty(), "", row.updatedAt, score)
        }
    }

    private fun score(row: FtsMatchRow, units: List<Query.Unit>, idf: List<Double>, average: Double): Double {
        val ints = ByteBuffer.wrap(row.info).order(ByteOrder.nativeOrder()).asIntBuffer()
        val values = IntArray(ints.remaining()).also { ints.get(it) }
        if (values.size < 2) return 0.0
        val count = values[0]
        val columns = values[1]
        // matchinfo numbers the MATCH's phrases left to right: each unit's, in order.
        val unitOf = units.flatMapIndexed { i, unit -> List(unit.phrases.size) { i } }
        if (count != unitOf.size || values.size < 2 + 3 * count * columns) return 0.0
        val f = DoubleArray(units.size)
        for (p in 0 until count) {
            val unit = unitOf[p]
            for (c in 0 until columns) {
                if (units[unit].title && c != TITLE_COLUMN) continue
                f[unit] += WEIGHTS.getOrElse(c) { 1.0 } * values[2 + 3 * (p * columns + c)]
            }
        }
        val norm = K1 * (1 - B + B * row.tokens / average)
        var total = 0.0
        for (i in units.indices) total += idf[i] * (f[i] * (K1 + 1)) / (f[i] + norm)
        return total
    }

    /** The query with its last [SearchCompletions.MAX_PREFIXES] prefixes' completions from the notes' words (A680). */
    private suspend fun complete(query: Query): Query {
        fun prefixOf(clause: Query.Clause): String? =
            clause.texts.singleOrNull()?.takeIf { clause.prefix && !clause.negated && it.length >= SearchCompletions.MIN_LENGTH }
        val prefixes = query.clauses.asReversed().mapNotNull(::prefixOf).distinct().take(SearchCompletions.MAX_PREFIXES)
        val found = prefixes.associateWith { SearchCompletions.completions(it, wordsStarting(it, SearchCompletions.SCAN)) }
        return Query(
            query.clauses.map { clause ->
                val words = prefixOf(clause)?.let { found[it] }.orEmpty()
                if (words.isEmpty()) clause else clause.copy(completions = words)
            },
        )
    }

    /**
     * The first words as written that start with [prefix], in code-point order: `note_word_terms`
     * (FTS4's `fts4aux` over [NoteWordFts], one row per word for all columns), made here the
     * first time. None if this SQLite cannot make it: the prefix's stem still matches, as before.
     */
    private suspend fun wordsStarting(prefix: String, limit: Int): List<String> = runCatching {
        if (!termsMade) {
            db.openHelper.writableDatabase.execSQL("CREATE VIRTUAL TABLE IF NOT EXISTS note_word_terms USING fts4aux(note_word_fts)")
            termsMade = true
        }
        val (from, to) = SearchCompletions.range(prefix)
        dao.words(
            SimpleSQLiteQuery(
                "SELECT term FROM note_word_terms WHERE col = '*' AND term >= ? AND term < ? AND documents > 0 ORDER BY term LIMIT $limit",
                arrayOf(from, to),
            ),
        )
    }.getOrDefault(emptyList())

    @Volatile private var termsMade = false

    /**
     * The shown notes' marked title and snippet, from FTS4's `offsets()` mapped onto the original
     * text: the whole title marked (core's `highlight`), and the body's snippet, or the headings'
     * when the body holds no match (core's `snippet`, 16 tokens).
     */
    private suspend fun marks(match: String, ids: List<String>): Map<String, Pair<String, String>> {
        if (ids.isEmpty()) return emptyMap()
        val rows = dao.offsets(
            SimpleSQLiteQuery(
                "SELECT t.noteId AS noteId, offsets(note_text_fts) AS offsets, t.title AS title, t.body AS body, t.headings AS headings, " +
                    "t.ftitle AS ftitle, t.fbody AS fbody, t.fheadings AS fheadings " +
                    "FROM note_text_fts JOIN note_texts t ON t.rowid = note_text_fts.rowid " +
                    "WHERE note_text_fts MATCH ? AND t.noteId IN (${ids.joinToString(",") { "?" }})",
                arrayOf(match, *ids.toTypedArray()),
            ),
        )
        return rows.associate { row ->
            val starts = Array(4) { HashSet<Int>() }
            val numbers = row.offsets.trim().split(' ').filter { it.isNotEmpty() }.map { it.toInt() }
            for (k in 0 until numbers.size / 4) {
                val column = numbers[k * 4]
                if (column in 0..3) starts[column] += numbers[k * 4 + 2]
            }
            val title = Marks(NoteTextEntity.searchText(row.title), row.ftitle, starts[TITLE_COLUMN])
            val body = Marks(NoteTextEntity.searchText(row.body), row.fbody, starts[BODY_COLUMN])
            val bodySnippet = body.snippet()
            val snippet = if (MATCH_START in bodySnippet || starts[HEADINGS_COLUMN].isEmpty()) {
                bodySnippet
            } else {
                Marks(NoteTextEntity.searchText(row.headings), row.fheadings, starts[HEADINGS_COLUMN]).snippet()
            }
            row.noteId to (title.highlight().takeIf { MATCH_START in it }.orEmpty() to snippet)
        }
    }

    /**
     * One column's tokens, with those FTS4 matched ([byteStarts]: their UTF-8 offsets in
     * [stored], the column as indexed). The i-th word of [stored] is the i-th token of [text]
     * ([SearchFold.indexed]), so its place there comes from counting [stored]'s bytes up to it:
     * nothing is stemmed again at read time (A610, review S-A), and a row stemmed by an older
     * [SearchStem] still marks the words it holds (N6). Only folding remains, to find each
     * token's original characters.
     */
    private class Marks(private val text: String, stored: String, byteStarts: Set<Int>) {
        private val tokens: List<SearchFold.Token> = SearchFold.fold(text).tokens()
        private val hits = BooleanArray(tokens.size)

        init {
            if (byteStarts.isNotEmpty()) {
                var word = 0
                var bytes = 0
                var inWord = false
                var i = 0
                while (i < stored.length && word < tokens.size) {
                    val c = stored[i]
                    if (c == ' ') {
                        if (inWord) word++
                        inWord = false
                    } else if (!inWord) {
                        inWord = true
                        if (bytes in byteStarts) hits[word] = true
                    }
                    bytes += utf8Bytes(stored, i)
                    i += if (Character.isHighSurrogate(c) && i + 1 < stored.length && Character.isLowSurrogate(stored[i + 1])) 2 else 1
                }
            }
        }

        /** The UTF-8 length of the character at [i], as SQLite stores it (a pair is 4 bytes). */
        private fun utf8Bytes(s: String, i: Int): Int {
            val c = s[i].code
            return when {
                c < 0x80 -> 1
                c < 0x800 -> 2
                Character.isHighSurrogate(s[i]) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> 4
                else -> 3
            }
        }

        fun highlight(): String = buildString {
            var at = 0
            tokens.forEachIndexed { i, token ->
                if (!hits[i]) return@forEachIndexed
                append(text, at, token.start).append(MATCH_START).append(text, token.start, token.end).append(MATCH_END)
                at = token.end
            }
            append(text, at, text.length)
        }

        /** Up to [size] tokens around the matches: the window with the most, from one token before its first. */
        fun snippet(size: Int = SNIPPET_TOKENS): String {
            if (tokens.isEmpty()) return text.take(200)
            var best = 0
            var bestCount = -1
            var count = 0
            for (i in tokens.indices) {
                if (hits[i]) count++
                if (i >= size && hits[i - size]) count--
                val start = max(0, i - size + 1)
                if (count > bestCount) {
                    bestCount = count
                    best = start
                }
            }
            var start = best
            if (bestCount > 0) {
                val first = (best until tokens.size).first { hits[it] }
                var last = first
                for (i in best until minOf(tokens.size, best + size)) if (hits[i]) last = i
                val shifted = max(0, first - 1)
                if (last < shifted + size) start = shifted
            }
            val end = minOf(tokens.size, start + size) - 1
            return buildString {
                if (start > 0) append(ELLIPSIS)
                var at = tokens[start].start
                for (i in start..end) {
                    if (!hits[i]) continue
                    val token = tokens[i]
                    append(text, at, token.start).append(MATCH_START).append(text, token.start, token.end).append(MATCH_END)
                    at = token.end
                }
                append(text, at, tokens[end].end)
                if (end < tokens.size - 1) append(ELLIPSIS)
            }
        }
    }

    /**
     * Whether the last word of [input] is still being typed (A111, as the web's `unfinished`):
     * the start of a word this phone's notes hold without being one. The server then embeds
     * the words before it only.
     */
    suspend fun unfinished(input: String): Boolean = withContext(work) { unfinishedHere(input) }

    private suspend fun unfinishedHere(input: String): Boolean {
        val last = Regex("(?:^|\\s)([^\\s\"]+)$").find(input)?.groupValues?.get(1) ?: return false
        val word = Query.words(last).singleOrNull() ?: return false
        if (word.length < Query.MIN_PREFIX_LENGTH) return false
        // As core's `unfinished`: not a whole (stemmed) term, but the start of one, or of a word
        // as written (`happin`, A680).
        return runCatching {
            idsMatching("\"${SearchStem.stem(word)}\"", 1).isEmpty() &&
                (idsMatching("\"$word*\"", 1).isNotEmpty() || wordsStarting(word, 1).isNotEmpty())
        }.getOrDefault(false)
    }

    private suspend fun idsMatching(match: String, limit: Int? = null): Set<String> = dao.ids(
        SimpleSQLiteQuery(
            "SELECT t.noteId FROM note_text_fts JOIN note_texts t ON t.rowid = note_text_fts.rowid " +
                "WHERE note_text_fts MATCH ?" + (if (limit != null) " LIMIT $limit" else ""),
            arrayOf(match),
        ),
    ).toSet()

    private suspend fun unindexed(input: String, filters: SearchFilters, folderIds: Set<String>?, limit: Int, skip: Set<String>, hidden: Set<String>): List<Hit> {
        val escaped = input.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        if (escaped.isEmpty() || limit <= 0) return emptyList()
        val where = StringBuilder()
        val args = mutableListOf<Any>("%$escaped%", "%$escaped%")
        filterSql(filters, folderIds, where, args, hidden)
        args += limit + skip.size
        return dao.unindexed(
            SimpleSQLiteQuery(
                "SELECT n.id AS id, n.title AS title, n.excerpt AS excerpt, n.updatedAt AS updatedAt, n.folderId AS folderId, n.position AS position " +
                    "FROM notes n WHERE n.deleted = 0 AND n.gone = 0 " +
                    "AND NOT EXISTS (SELECT 1 FROM note_texts t WHERE t.noteId = n.id) " +
                    "AND (n.title LIKE ? ESCAPE '\\' OR n.excerpt LIKE ? ESCAPE '\\')$where " +
                    "ORDER BY n.updatedAt DESC LIMIT ?",
                args.toTypedArray(),
            ),
        ).asSequence().filter { it.id !in skip }.take(limit).map { Hit(it.id, it.title, "", "", it.excerpt, it.updatedAt) }.toList()
    }

    /** The filters on notes aliased `n` (T40 P6, FD3): applied in Room, offline. */
    private fun filterSql(filters: SearchFilters, folderIds: Set<String>?, where: StringBuilder, args: MutableList<Any>, hidden: Set<String> = emptySet()) {
        if (hidden.isNotEmpty()) {
            // Closed notebooks' folders (T43, A752); a note at the top level is the default notebook's.
            where.append(" AND (n.folderId IS NULL OR n.folderId NOT IN (${hidden.joinToString(",") { "?" }}))")
            args.addAll(hidden)
        }
        if (folderIds != null) {
            where.append(" AND n.folderId IN (${folderIds.joinToString(",") { "?" }})")
            args.addAll(folderIds)
        }
        filters.tag?.let { tag ->
            // The tag, or one nested under it (`area` finds `area/cooking`), as the server's filter;
            // `substr`, as the tag browser's (A467), so `_` is never a wildcard.
            where.append(" AND EXISTS (SELECT 1 FROM note_tags g WHERE g.noteId = n.id AND (g.tag = ? OR substr(g.tag, 1, length(?) + 1) = ? || '/'))")
            args += tag
            args += tag
            args += tag
        }
        filters.updatedAfter?.let {
            where.append(" AND n.updatedAt >= ?")
            args += it
        }
    }

    /** A folder and every folder under it. */
    private suspend fun folderSubtree(id: String): Set<String> {
        val children = db.folders().all().groupBy { it.parentId }
        val out = linkedSetOf<String>()
        fun visit(folderId: String) {
            if (!out.add(folderId)) return
            children[folderId].orEmpty().forEach { visit(it.id) }
        }
        visit(id)
        return out
    }

    /**
     * A query as the server reads one (`parseQuery`, A117): its clauses, and FTS4's MATCH
     * expression for them. Every token is quoted, so nothing typed is FTS syntax.
     */
    internal data class Query(val clauses: List<Clause>) {
        /** [completions]: a prefix's whole words as written that its stem does not reach (A680). */
        data class Clause(val texts: List<String>, val prefix: Boolean, val title: Boolean, val negated: Boolean, val completions: List<String> = emptyList())

        /** What bm25 scores on its own (core's phrase): its MATCH phrases, in the title only or anywhere. */
        data class Unit(val phrases: List<String>, val title: Boolean)

        /** The excluded clauses' MATCH expressions, each of which leaves a note out. */
        fun exclusions(): List<String> = clauses.filter { it.negated }.map { phrases(it).joinToString(" ") }

        companion object {
            const val MAX_CLAUSES = 12
            const val MIN_PREFIX_LENGTH = 2
            private val TITLE = Regex("^title:(?=\\S)", RegexOption.IGNORE_CASE)

            /** The words of a part, folded as the index folds text (core's `tokenize(text, { stem: false })`). */
            fun words(text: String): List<String> = SearchFold.terms(text)

            /**
             * A clause's MATCH phrases (every word quoted or folded, so nothing typed is FTS
             * syntax). FTS4 takes a column only before a bare term, so a `title:` phrase is each of
             * its words in the title (folded: lower-case letters and digits, never an operator).
             */
            /** A clause's units: itself, then each completion, matched as a whole (stemmed) word. */
            fun units(clause: Clause): List<Unit> = listOf(Unit(phrases(clause), clause.title)) +
                clause.completions.map { word ->
                    val stem = SearchStem.stem(word)
                    Unit(listOf(if (clause.title) "ftitle:$stem" else "\"$stem\""), clause.title)
                }

            /** A clause's MATCH expression: its phrases, or (with completions) its units ORed. */
            fun match(clause: Clause): String =
                if (clause.completions.isEmpty()) phrases(clause).joinToString(" ") else units(clause).joinToString(" OR ") { it.phrases.single() }

            fun phrases(clause: Clause): List<String> {
                val star = if (clause.prefix) "*" else ""
                // Stemmed as the index is (core's `stemTerm`, a prefix too: review R4).
                val stems = clause.texts.map(SearchStem::stem)
                if (clause.title) return stems.mapIndexed { i, word -> "ftitle:$word" + if (i == stems.size - 1) star else "" }
                return listOf("\"" + stems.joinToString(" ") + star + "\"")
            }

            fun parse(input: String, prefixLast: Boolean): Query {
                data class Part(val text: String, val quoted: Boolean, val negated: Boolean, val title: Boolean)
                val parts = mutableListOf<Part>()
                var at = 0
                while (at < input.length) {
                    if (input[at].isWhitespace()) {
                        at++
                        continue
                    }
                    var negated = false
                    var title = false
                    if (input[at] == '-' && at + 1 < input.length && !input[at + 1].isWhitespace()) {
                        negated = true
                        at++
                    }
                    TITLE.find(input.substring(at))?.let {
                        title = true
                        at += it.value.length
                    }
                    if (at < input.length && input[at] == '"') {
                        val close = input.indexOf('"', at + 1)
                        parts += Part(input.substring(at + 1, if (close == -1) input.length else close), true, negated, title)
                        at = if (close == -1) input.length else close + 1
                        continue
                    }
                    var end = at
                    while (end < input.length && !input[end].isWhitespace() && input[end] != '"') end++
                    parts += Part(input.substring(at, end), false, negated, title)
                    at = end
                }
                val typingLast = prefixLast && input.isNotEmpty() && !input.last().isWhitespace() && input.last() != '"'
                val clauses = mutableListOf<Clause>()
                parts.forEachIndexed { index, part ->
                    val texts = words(part.text)
                    if (texts.isEmpty()) return@forEachIndexed
                    if (texts.size > 1) {
                        clauses += Clause(texts, prefix = false, title = part.title, negated = part.negated)
                        return@forEachIndexed
                    }
                    val starred = !part.quoted && part.text.endsWith("*")
                    val wantsPrefix = !part.negated && (starred || (!part.quoted && typingLast && index == parts.size - 1))
                    clauses += Clause(texts, prefix = wantsPrefix && texts[0].length >= MIN_PREFIX_LENGTH, title = part.title, negated = part.negated)
                }
                return Query(clauses.take(MAX_CLAUSES))
            }
        }
    }

    companion object {
        const val DEFAULT_LIMIT = 30
        const val MATCH_START = "\u0002"
        const val MATCH_END = "\u0003"
        const val ELLIPSIS = "…"

        /** Tokens per snippet, as the server's (`SNIPPET_TOKENS`). */
        const val SNIPPET_TOKENS = 16

        /** The server's bm25 column weights (`FTS_WEIGHTS`), in column order: title, body, tags, headings. */
        private val WEIGHTS = doubleArrayOf(10.0, 1.0, 5.0, 4.0)
        private const val TITLE_COLUMN = 0
        private const val BODY_COLUMN = 1
        private const val HEADINGS_COLUMN = 3
        private const val K1 = 1.2
        private const val B = 0.75

        /** FTS5's smallest idf (a clause in more than half the notes), as core's `MIN_IDF`. */
        private const val MIN_IDF = 1e-6
    }
}
