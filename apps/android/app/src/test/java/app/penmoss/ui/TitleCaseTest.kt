package app.penmoss.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Android's Title Case is core's (PEN-137, T12): every case core wrote to
 * `apps/android/contract/title-case-v1.json` comes out the same here, and the examples of core's
 * `title-case.test.ts` hold too.
 */
class TitleCaseTest {
    private val contract = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("title-case-v1.json") } ?: File("../contract/title-case-v1.json")).readText(),
    ).jsonObject

    @Test
    fun everyCaseIsCores() {
        val cases = contract.getValue("cases").jsonArray.map { pair -> pair.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } }
        assertTrue(cases.size > 60)
        val wrong = cases.filter { (text, want) -> TitleCase.titleCase(text) != want }
            .map { (text, want) -> "\"$text\": core \"$want\", Kotlin \"${TitleCase.titleCase(text)}\"" }
        assertEquals(emptyList<String>(), wrong)
        assertEquals(contract.getValue("shortWords").jsonArray.map { it.jsonPrimitive.content }, TitleCase.SHORT_WORDS.toList())
    }

    @Test
    fun thePlansExamplesAreAlreadyRight() {
        for (text in listOf("Move to Folder", "Keep at Most", "Sign In with GitHub", "Delete “X” for Good?", "Send To…", "Reset My Analytics ID", "Don’t Share")) {
            assertTrue(text, TitleCase.isTitleCase(text))
            assertNull(TitleCase.problem(text))
        }
    }

    @Test
    fun theSweepsOldTextsAreNot() {
        val sweep = listOf(
            "Discard this draft?" to "Discard This Draft?",
            "Load Pictures From the Web" to "Load Pictures from the Web",
            "Not synced yet" to "Not Synced Yet",
            "Turn off sharing" to "Turn Off Sharing",
            "Back up on the phone" to "Back Up on the Phone",
        )
        for ((before, after) in sweep) {
            assertEquals(after, TitleCase.titleCase(before))
            assertFalse(TitleCase.isTitleCase(before))
        }
    }

    @Test
    fun theProblemNamesTheFirstWordThatBreaksTheRule() {
        assertEquals("\"To\" should be \"to\" in \"Move To folder\"", TitleCase.problem("Move To folder"))
    }
}
