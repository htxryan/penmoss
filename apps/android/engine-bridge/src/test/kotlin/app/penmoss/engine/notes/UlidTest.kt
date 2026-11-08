package app.penmoss.engine.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** New notes' ids as `@penmoss/core/ids` makes them (T38). */
class UlidTest {
    private val pattern = Regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$")

    @Test
    fun makesUlidsThatSortByTime() {
        val first = Ulid.next(1_761_200_000_000)
        val later = Ulid.next(1_761_200_000_001)
        assertTrue(first, pattern.matches(first))
        assertTrue(first < later)
        // The time part, as `ulid()` encodes it: 48 bits of milliseconds in Crockford base32.
        assertEquals("0000000000", Ulid.next(0).take(10))
        assertEquals("7ZZZZZZZZZ", Ulid.next(0xFFFF_FFFF_FFFFL).take(10))
        assertEquals(1_000, (1..1_000).map { Ulid.next(5) }.toSet().size)
    }
}
