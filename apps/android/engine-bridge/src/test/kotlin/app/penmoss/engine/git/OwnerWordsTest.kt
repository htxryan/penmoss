package app.penmoss.engine.git

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The owner check's words for a git notebook (A855, A877): as the Mac's tests of the same words. */
class OwnerWordsTest {
    private val id = "01JBN0000000000000000000P1"

    @Test
    fun aTitleIsBracketedIsolatedAndCleanedSoItCannotFakeTheWordsAroundIt() {
        assertEquals("[⁨Plan⁩]", OwnerWords.note(id, "Plan"))
        // Bidi controls, zero-width characters, quotes and brackets go; spaces collapse.
        assertEquals("[⁨Budget gnirts x y⁩]", OwnerWords.note(id, "Budget ‮gnirts⁩​] x\n\"y\""))
        assertEquals("an untitled note (…0000P1)", OwnerWords.note(id, "‮⁩ "))
        assertEquals("an untitled note (…0000P1)", OwnerWords.note(id, null))
        val long = OwnerWords.note(id, "z".repeat(70))
        assertEquals("[⁨${"z".repeat(59)}…⁩]", long)
    }

    @Test
    fun aTitleOnScreenIsCleanedAndIsolatedAsTheCheckNamesItWithoutBrackets() {
        assertEquals("\u2068Budget gnirts\u2069", OwnerWords.title("Budget \u202Egnirts\u2069"))
        assertEquals("\u2068Plan Keep\u2069", OwnerWords.title("Plan\u200B\u201C] Keep"))
        assertEquals(null, OwnerWords.title("\u202E\u2069 "))
        assertEquals(null, OwnerWords.title(null))
        assertEquals(OwnerWords.TITLE_MAX + 2, OwnerWords.title("z".repeat(90))!!.length)
    }

    @Test
    fun emojiSequencesStayWholeAndACutNeverSplitsACharacter() {
        // As the Mac's `cleanTitle` (#174 review): a joiner only inside an emoji sequence, a
        // subdivision flag's tags kept, and no half of a surrogate pair at the cut.
        val family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"
        val scotland = "\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F"
        assertEquals("\u2068Plan $family $scotland\u2069", OwnerWords.title("Plan $family $scotland"))
        assertEquals("\u2068Sha lom\u2069", OwnerWords.title("Sha\u200Dlom"))
        val cut = OwnerWords.title("${"a".repeat(58)}\uD83D\uDE00\uD83D\uDE00")!!
        assertEquals("\u2068${"a".repeat(58)}…\u2069", cut)
    }

    @Test
    fun aLongPathIsShortenedInItsMiddleSoTheNoteIsAlwaysNamedWhole() {
        val path = "/data/user/0/app.penmoss/${"deep/".repeat(40)}notes.git on this phone"
        val title = OwnerWords.note(id, "z".repeat(70))
        val words = OwnerWords.fit("delete 1 note for good (git history keeps it) in the git notebook at ", path, ": $title")
        assertTrue(words.length <= OwnerWords.MAX)
        assertTrue(words, words.endsWith(": $title"))
        assertTrue(words, Regex("^delete 1 note for good \\(git history keeps it\\) in the git notebook at /data/user/0/app\\.penmoss/deep/.*….*notes\\.git on this phone: ").containsMatchIn(words))
        assertEquals("remove github.com/htxryan/notes from this phone", OwnerWords.fit("remove ", "github.com/htxryan/notes", " from this phone"))
    }

    @Test
    fun aCutNeverLandsInsideAnIsolatedTitleNorInsideACharacter() {
        val title = OwnerWords.note(id, "Plan")
        val words = OwnerWords.check("${"w".repeat(195)} $title")
        assertEquals("${"w".repeat(195)}…", words)
        assertFalse(Regex("[⁨⁩\\[]").containsMatchIn(words))
        assertEquals("${"e".repeat(196)}…", OwnerWords.check("${"e".repeat(196)}😀😀😀😀"))
        // Line breaks never reach the prompt.
        assertEquals("one two", OwnerWords.check("one\ntwo"))
    }
}
