package app.penmoss.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The phone folds text as the server's tokenizer does (T40 P6, review B1):
 * `contract/search-fold-v1.json` holds unicode61's tables and the folded words core's
 * `tokenize(text, { stem: false })` makes of sample text (written by the page's
 * `search-contract.test.ts`); [SearchFold] must hold the same tables and make the same words,
 * and [SearchStem] the same stems as core's `stemTerm`.
 */
class SearchFoldTest {
    private val contract = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("search-fold-v1.json") } ?: File("../contract/search-fold-v1.json")).readText(),
    ).jsonObject

    @Test
    fun holdsCoresUnicode61Tables() {
        assertEquals(contract.getValue("separatorRanges").jsonPrimitive.content, UnicodeFoldTable.SEPARATOR_RANGES)
        assertEquals(contract.getValue("foldExceptions").jsonPrimitive.content, UnicodeFoldTable.FOLD_EXCEPTIONS)
    }

    @Test
    fun foldsEverySampleIntoCoresWords() {
        val cases = contract.getValue("cases").jsonArray
        val wrong = cases.mapNotNull { case ->
            val (text, words) = case.jsonArray.map { it.jsonPrimitive.content }
            val folded = SearchFold.terms(text).joinToString(" ")
            if (folded == words) null else "${text.codePoints().toArray().joinToString(",") { Integer.toHexString(it) }}: $folded ≠ $words"
        }
        assertEquals(emptyList<String>(), wrong)
        assert(cases.size > 2_000) { "too few cases: ${cases.size}" }
    }

    @Test
    fun stemsEveryTermAsCoreDoes() {
        // Review R4: the phone stems in Kotlin (SearchStem, core's stemTerm) and indexes with
        // FTS4's simple tokenizer, so digits, long words and long CJK runs stay whole.
        val stems = contract.getValue("stems").jsonArray
        val wrong = stems.mapNotNull { case ->
            val (term, stem) = case.jsonArray.map { it.jsonPrimitive.content }
            val mine = SearchStem.stem(term)
            if (mine == stem) null else "$term: $mine ≠ $stem"
        }
        assertEquals(emptyList<String>(), wrong)
        assert(stems.size > 100) { "too few stems: ${stems.size}" }
    }

    @Test
    fun completesEveryPrefixAsCoreDoes() {
        // #120 (A680): the phone completes a partly typed word from its notes' words as core does.
        val cases = contract.getValue("completions").jsonArray
        val wrong = cases.mapNotNull { case ->
            val (prefix, words, expected) = case.jsonArray.toList()
            val from = words.jsonArray.map { it.jsonPrimitive.content }
            val want = expected.jsonArray.map { it.jsonPrimitive.content }
            val mine = SearchCompletions.completions(prefix.jsonPrimitive.content, from)
            if (mine == want) null else "${prefix.jsonPrimitive.content}: $mine ≠ $want"
        }
        assertEquals(emptyList<String>(), wrong)
        assert(cases.size > 10) { "too few completion cases: ${cases.size}" }
    }

    @Test
    fun mapsEachTokenBackToTheOriginalCharacters() {
        val text = "Ryan’s ÉCLAIR — “cream” 😀x a\u0301b"
        val tokens = SearchFold.fold(text).tokens()
        assertEquals(listOf("Ryan", "s", "ÉCLAIR", "cream", "x", "a\u0301b"), tokens.map { text.substring(it.start, it.end) })
        assertEquals(listOf("ryan", "s", "eclair", "cream", "x", "ab"), SearchFold.terms(text))
        // Review N1: a mark that ends a word (NFD) stays in the word, as core's token does.
        val nfd = "Cafe\u0301 au lait"
        assertEquals(listOf("Cafe\u0301", "au", "lait"), SearchFold.fold(nfd).tokens().map { nfd.substring(it.start, it.end) })
    }
}
