package app.penmoss.engine.notes

import java.net.URI
import java.net.URISyntaxException

/** Where a `penmoss://` link leads (T40 P7, PL5, A476). */
sealed interface DeepLink {
    /** Opens the note: never creates, moves or deletes anything. */
    data class Note(val id: String) : DeepLink

    /** Opens the capture sheet, empty: what is saved is what Ryan types there. */
    data object Capture : DeepLink
}

/**
 * Deep links, as the Mac app reads them (`apps/desktop/src/deep-link.ts`, T29):
 * `penmoss://note/<id>` opens a note and `penmoss://capture` the capture sheet; anything else is
 * ignored, since a link is data from whatever app sent it. The id must be a ULID (every note
 * id is one) or a note's short reference (PEN-69, `K7QD-9HTF2CXA`, the app finds the note it
 * names), upper-cased as the Mac app does; a query or fragment changes nothing.
 * `penmoss://auth/callback` is the sign-in's (A283), never read here.
 */
object DeepLinks {
    const val SCHEME = "penmoss"
    private val NOTE_ID = Regex("^[0-9A-HJKMNP-TV-Z]{26}$", RegexOption.IGNORE_CASE)

    /** A short reference (PEN-69): the notebook's 4 characters, then the note's last 8 or its ULID. */
    private val SHORT_REF = Regex("^[0-9A-Z]{4}-([0-9A-Z]{8}|[0-9A-Z]{26})$", RegexOption.IGNORE_CASE)

    fun parse(link: String?): DeepLink? {
        if (link == null) return null
        val uri = try {
            URI(link)
        } catch (_: URISyntaxException) {
            return null
        }
        if (!uri.scheme.equals(SCHEME, ignoreCase = true) || uri.isOpaque) return null
        val parts = (uri.path ?: "").split('/').filter { it.isNotEmpty() }
        return when (uri.host?.lowercase()) {
            "capture" -> DeepLink.Capture.takeIf { parts.isEmpty() }
            "note" -> parts.singleOrNull()?.takeIf { NOTE_ID.matches(it) || SHORT_REF.matches(it) }?.let { DeepLink.Note(it.uppercase()) }
            else -> null
        }
    }
}
