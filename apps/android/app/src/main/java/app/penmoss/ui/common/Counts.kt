package app.penmoss.ui.common

import java.util.Locale

/**
 * A count and its word, its number grouped: "1 subfolder", "3 copies", "1,234 notes". As core's
 * `counted` (`@penmoss/core/words`), so a count reads the same on the Mac and the phone (A1683).
 */
fun counted(count: Int, one: String, many: String = "${one}s"): String =
    "${String.format(Locale.US, "%,d", count)} ${if (count == 1) one else many}"

/** "1 note", "3 notes", "1,234 notes": every count of notes the app writes. */
fun noteCount(count: Int): String = counted(count, "note", "notes")
