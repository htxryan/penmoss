package app.penmoss.feedback

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Feedback's Recent errors as they leave the phone (T49, A791): the scrub the error reports used
 * (A427), kept from ErrorReporterTest when the reporter went with the server (T59).
 */
class ErrorScrubTest {
    private val notes = listOf("Trip to Lisbon", "Health", "Divorce lawyer")

    private fun message(fixed: String, free: String, names: Collection<String>? = notes) = ErrorScrub.scrubbed(fixed, free, "", names).first

    @Test
    fun aTitleOrFolderNameOrQuotedTextNeverLeavesThePhone() {
        assertEquals("IllegalArgumentException: Could not save ‹name› in ‹name›", message("IllegalArgumentException", "Could not save Trip to Lisbon in Health"))
        assertEquals("Edits are kept in ‹name›", message("", "Edits are kept in “My private diary”"))
    }

    @Test
    fun quotedTextOfEveryKindIsScrubbed() {
        assertEquals("Could not open ‹name› today", message("", "Could not open \"Secret plan\" today"))
        assertEquals("Bad title ‹name› here", message("", "Bad title \"He said \\\"call the lawyer\\\" today\" here"))
        // A quote left open (a message cut short): what follows it is never kept.
        assertEquals("Unclosed ‹name›", message("", "Unclosed “call the lawyer"))
        assertEquals("x ‹name›", message("", "x \"call the lawyer about the house"))
        // An apostrophe is not a quote.
        assertEquals("Can't open it", message("", "Can't open it"))
    }

    /** Review of #93, S1: kotlinx.serialization quotes the reply it could not read; that part never goes. */
    @Test
    fun aJsonErrorNeverKeepsTheReplyItQuotes() {
        val error = try {
            Json.decodeFromString(JsonObject.serializer(), """{"notes":[{"title":"He said \"call the lawyer\" today","pinned":tru""")
            fail("the reply was read")
            throw AssertionError()
        } catch (error: SerializationException) {
            error
        }
        assertTrue(error.message!!.contains("JSON input:"))
        val (message, detail) = ErrorScrub.scrubbed("SerializationException", error.message!!, error.stackTraceToString(), notes)
        assertTrue(message.contains("JSON input: ‹withheld›"))
        assertFalse(message.contains("lawyer"))
        assertFalse(detail.contains("lawyer"))
    }

    /** Review of #93, N5: stack frames stay readable, and a name inside a longer word stays. */
    @Test
    fun framesAndPartsOfWordsAreLeftAlone() {
        val error = IllegalStateException("Healthy Health")
        val (message, detail) = ErrorScrub.scrubbed("IllegalStateException", "Healthy Health", error.stackTraceToString(), listOf("penmoss", "feedback", "Health"))
        assertEquals("IllegalStateException: Healthy ‹name›", message)
        assertTrue(detail.contains("\tat app.penmoss.feedback.ErrorScrubTest"))
        assertTrue(detail.startsWith("java.lang.IllegalStateException: Healthy ‹name›"))
    }

    @Test
    fun withoutNamesOnlyTheKindAndFramesAreKept() {
        val error = RuntimeException("Trip to Lisbon")
        val (message, detail) = ErrorScrub.scrubbed("RuntimeException", "Trip to Lisbon", error.stackTraceToString(), null)
        assertEquals("RuntimeException: ‹withheld›", message)
        assertFalse(detail.contains("Lisbon"))
        assertTrue(detail.startsWith("java.lang.RuntimeException: ‹withheld›"))
        assertTrue(detail.contains("\tat app.penmoss.feedback.ErrorScrubTest"))
        // Names too short to scrub count as none.
        assertEquals("RuntimeException: ‹withheld›", message("RuntimeException", "To a", listOf("To", "a")))
    }
}
