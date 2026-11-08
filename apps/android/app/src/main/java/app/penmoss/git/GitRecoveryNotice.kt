package app.penmoss.git

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What came of Android clearing a git notebook's engine store (A886): when, the titles notes came
 * back as ("… (recovered)"), and the titles of copies that could not be brought back (kept in
 * Room, for the person to save). [quiet]: dismissed, until something new happens.
 */
@Serializable
data class GitRecoveryNotice(
    val at: Long,
    val titles: List<String>,
    val unrecovered: List<String> = emptyList(),
    val quiet: Boolean = false,
) {
    fun encode(): String = JSON.encodeToString(serializer(), this)

    /** Settings and the notebook's Sync show it. */
    val shown: Boolean get() = !quiet && (titles.isNotEmpty() || unrecovered.isNotEmpty())

    /** What Settings and the notebook's Sync say. */
    fun words(): String = buildString {
        append("Android cleared this notebook's storage on the phone, as it does when space runs low. ")
        if (titles.isNotEmpty()) {
            val count = if (titles.size == 1) "1 note" else "${titles.size} notes"
            append("$count held changes not pushed yet: they are back as notes of their own, ${list(titles)}. ")
            append("Compare each with its note and keep what you need. ")
        }
        if (unrecovered.isNotEmpty()) {
            val count = if (unrecovered.size == 1) "1 copy" else "${unrecovered.size} copies"
            append("$count couldn't be recovered, ${list(unrecovered)}: kept on this phone. Save their text to keep what can be read.")
        } else {
            append("Nothing else was lost.")
        }
    }.trim()

    private fun list(items: List<String>) =
        items.take(MAX_SHOWN).joinToString(", ") { "“${it.ifBlank { "Untitled" }}”" } + if (items.size > MAX_SHOWN) ", …" else ""

    companion object {
        private const val MAX_SHOWN = 5
        private val JSON = Json { ignoreUnknownKeys = true }

        fun decode(text: String): GitRecoveryNotice = JSON.decodeFromString(serializer(), text)
    }
}
