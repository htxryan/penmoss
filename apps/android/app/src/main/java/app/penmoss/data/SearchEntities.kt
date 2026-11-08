package app.penmoss.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.FtsOptions
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A note's text in the offline index (T40 P6, FD4): what the server indexes (its plain text,
 * capped at 256 KB, and its headings), from `/sync/batch` replies or the editor page, with its
 * title and tags kept current from `/sync/changes`. The original columns are what snippets and
 * marked titles show; the `f…` columns are the same text folded and stemmed as the server's
 * tokenizer folds and stems it ([SearchFold], [SearchStem]), which [NoteTextFts] indexes (review
 * B1, R4). [tokens] counts the folded words of
 * all four, bm25's row length. [fwords] lists their distinct words as written (folded, not
 * stemmed), which [NoteWordFts] indexes to complete a partly typed word (#120, A680). Room's
 * triggers keep both indexes current. Cleared at sign-out.
 */
@Entity(tableName = "note_texts")
data class NoteTextEntity(
    @PrimaryKey val noteId: String,
    val title: String,
    val body: String,
    /** Space-separated, as the server's `notes_fts` holds them. */
    val tags: String,
    /** One per line. */
    val headings: String,
    val ftitle: String,
    val fbody: String,
    val ftags: String,
    val fheadings: String,
    val tokens: Int,
    /** The distinct folded words of all four columns, unstemmed, space-separated (A680). */
    @ColumnInfo(defaultValue = "") val fwords: String = "",
) {
    companion object {
        /** A row for these columns, folded and counted. */
        fun of(noteId: String, title: String, body: String, tags: String, headings: String): NoteTextEntity {
            val words = listOf(title, body, tags, headings).map { SearchFold.terms(searchText(it)) }
            // As SearchFold.indexed: each folded word stemmed as the server stems it.
            val columns = words.map { column -> column.joinToString(" ") { SearchStem.stem(it) } }
            val tokens = words.sumOf { it.size }
            val distinct = words.flatten().distinct().joinToString(" ")
            return NoteTextEntity(noteId, title, body, tags, headings, columns[0], columns[1], columns[2], columns[3], tokens, distinct)
        }

        /** Text without the match markers, which the index and the marks never see (core's `searchText`, A118). */
        fun searchText(text: String): String = if ('\u0002' in text || '\u0003' in text) text.replace('\u0002', ' ').replace('\u0003', ' ') else text
    }
}

/**
 * The full-text index over [NoteTextEntity]'s folded, stemmed columns (FTS4, external content),
 * in the server's column order (title, body, tags, headings). SQLite's `simple` tokenizer only
 * cuts them at the spaces Kotlin left (A462): FTS4's `porter` would cut long words and words
 * with digits short, so a prefix of them would never match (review R4).
 */
@Fts4(contentEntity = NoteTextEntity::class, tokenizer = FtsOptions.TOKENIZER_SIMPLE)
@Entity(tableName = "note_text_fts")
data class NoteTextFts(
    val ftitle: String,
    val fbody: String,
    val ftags: String,
    val fheadings: String,
)

/**
 * The words of [NoteTextEntity] as written (#120, A680): FTS4 over [NoteTextEntity.fwords], cut at
 * the spaces Kotlin left (`simple`). Never searched itself; its `fts4aux` table (`note_word_terms`,
 * made by [OfflineSearch]) lists the words in order, so a prefix finds the words it starts.
 */
@Fts4(contentEntity = NoteTextEntity::class, tokenizer = FtsOptions.TOKENIZER_SIMPLE)
@Entity(tableName = "note_word_fts")
data class NoteWordFts(val fwords: String)

/**
 * One tag of one note (T40 P6, FD3, TG1), frontmatter or inline, as `/sync/changes` last said:
 * the search's Tag filter offline, and the tag browser.
 */
@Entity(tableName = "note_tags", primaryKeys = ["noteId", "tag"], indices = [Index("tag")])
data class NoteTagEntity(val noteId: String, val tag: String)

/** One full-text match: the note, FTS4's `matchinfo('pcx')` and its row length, ranked in Kotlin as core ranks. */
data class FtsMatchRow(val noteId: String, val info: ByteArray, val tokens: Int, val title: String, val updatedAt: Long) {
    override fun equals(other: Any?): Boolean = other is FtsMatchRow && other.noteId == noteId && other.info.contentEquals(info)

    override fun hashCode(): Int = noteId.hashCode()
}

/** A match's original and indexed columns and FTS4's `offsets()`, for marking titles and snippets (A610). */
data class FtsOffsetsRow(
    val noteId: String,
    val offsets: String,
    val title: String,
    val body: String,
    val headings: String,
    val ftitle: String,
    val fbody: String,
    val fheadings: String,
)

/** How many notes the index holds and their folded words in all, for bm25's idf and average length. */
data class FtsStatsRow(val notes: Int, val tokens: Long)

/** A tag and how many live notes carry it (T40 P6). */
data class TagCountRow(val tag: String, val notes: Int)
