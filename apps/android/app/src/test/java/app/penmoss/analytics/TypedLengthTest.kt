package app.penmoss.analytics

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The length typed in a field (PEN-177, AC14): recorded 500 ms after typing stops, at once when
 * the field closes with a change waiting, never its text, a length equal to the last dropped, and
 * the length it opened with taken as recorded.
 */
class TypedLengthTest {
    private val clock = FakeScrollClock()
    private val recorded = mutableListOf<Triple<Long, String, Int>>()
    private fun field(start: Int = 0) = TypedLength("search", "query", start, clock) { dialog, field, chars ->
        recorded += Triple(clock.now(), "$dialog.$field", chars)
    }

    @Test
    fun recordsTheLengthOnceTypingSettles() {
        val typed = field()
        for ((at, length) in listOf(0L to 1, 120L to 2, 240L to 3, 360L to 4, 480L to 5, 600L to 6)) {
            clock.advance(at)
            typed.typed(length)
        }
        clock.advance(1_099)
        assertEquals(emptyList<Triple<Long, String, Int>>(), recorded)
        clock.advance(1_100)
        assertEquals(listOf(Triple(1_100L, "search.query", 6)), recorded)
        // The same length again is dropped; another is recorded.
        typed.typed(6)
        clock.advance(3_000)
        typed.typed(4)
        clock.advance(4_000)
        assertEquals(listOf(Triple(1_100L, "search.query", 6), Triple(3_500L, "search.query", 4)), recorded)
    }

    @Test
    fun openingRecordsNothingAndClosingSendsWhatWaits() {
        val typed = field(start = 3)
        typed.typed(3)
        clock.advance(2_000)
        assertEquals(emptyList<Triple<Long, String, Int>>(), recorded)
        typed.typed(9)
        clock.advance(2_100)
        typed.flush()
        assertEquals(listOf(Triple(2_100L, "search.query", 9)), recorded)
        typed.flush()
        clock.advance(5_000)
        assertEquals(1, recorded.size)
    }

    @Test
    fun aHugeLengthIsClamped() {
        val typed = field()
        typed.typed(2_000_000)
        clock.advance(600)
        assertEquals(1_000_000, recorded.single().third)
    }
}
