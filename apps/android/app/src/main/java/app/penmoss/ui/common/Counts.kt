package app.penmoss.ui.common

import java.util.Locale

/** "1 note", "3 notes", "1,234 notes": every count of notes the app writes, its number grouped. */
fun noteCount(count: Int): String = if (count == 1) "1 note" else String.format(Locale.US, "%,d notes", count)
