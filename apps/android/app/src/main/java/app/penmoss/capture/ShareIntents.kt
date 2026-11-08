package app.penmoss.capture

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

/** What a capture starts with: text to edit, and pictures to store with it. */
data class CaptureDraft(val text: String = "", val pictures: List<Uri> = emptyList())

/**
 * What another app shares, read as a capture (T34, A339). A web page (Chrome
 * shares its address as the text and its title as the subject) becomes its
 * title on the first line and its address below, so a new Inbox note is
 * titled by the page and today's note shows `**14:05** Title <address>`.
 * Pictures are only ever read from a `content:` address another app granted,
 * never one of this app's own, so a share cannot make the phone upload its
 * own files.
 */
object ShareIntents {
    /** The tile's and the widget's intent: an empty capture. */
    const val ACTION_CAPTURE = "app.penmoss.action.CAPTURE"

    /** Pictures one share may bring, as the photo picker (T33). */
    const val MAX_PICTURES = 10

    /**
     * UTF-8 bytes of shared text kept (A347): the server takes 256 KB a capture, pictures'
     * lines included, so the text stops well short of it whatever its script.
     */
    const val MAX_TEXT = 200 * 1024

    private val ADDRESS = Regex("""https?://[^\s<>"]+""", RegexOption.IGNORE_CASE)

    /** The draft for an intent, or null for one that is not a capture. */
    fun draftOf(intent: Intent, ownPackage: String, ownerOf: (String) -> String? = { null }): CaptureDraft? {
        val type = intent.type.orEmpty()
        return when (intent.action) {
            ACTION_CAPTURE -> CaptureDraft()
            Intent.ACTION_SEND -> {
                val text = textOf(intent)
                val pictures = if (type.startsWith("image/")) {
                    listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                } else {
                    emptyList()
                }
                draft(text, pictures, ownPackage, ownerOf)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                if (!type.startsWith("image/")) return null
                val pictures = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                draft(textOf(intent), pictures, ownPackage, ownerOf)
            }
            else -> null
        }
    }

    private fun draft(text: String, pictures: List<Uri>, ownPackage: String, ownerOf: (String) -> String?): CaptureDraft? {
        val readable = pictures.filter { readable(it, ownPackage, ownerOf) }.distinct().take(MAX_PICTURES)
        if (text.isBlank() && readable.isEmpty()) return null
        return CaptureDraft(text, readable)
    }

    /**
     * Only what another app shared with this one: a content address that is not this app's,
     * by its name and by the app the system says serves it (`ownerOf`, A349), so a provider
     * merged in from a library under a name of its own is refused too.
     */
    fun readable(uri: Uri, ownPackage: String, ownerOf: (String) -> String? = { null }): Boolean =
        uri.scheme == ContentResolver.SCHEME_CONTENT &&
            uri.authority.orEmpty().let {
                it.isNotEmpty() && it != ownPackage && !it.startsWith("$ownPackage.") &&
                    runCatching { ownerOf(it) }.getOrNull() != ownPackage
            }

    private fun textOf(intent: Intent): String {
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty().trim()
        val subject = (intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE))
            ?.toString().orEmpty().trim()
        return Utf8.cut(compose(text, subject), MAX_TEXT)
    }

    /**
     * Shared text as a capture. With a web address in it: the page's title (the subject, else
     * the words around the address, else the address's host) on the first line, the address
     * below as a link. Without one: the subject, when there is one the text does not start
     * with, then the text.
     */
    fun compose(text: String, subject: String): String {
        val found = ADDRESS.find(text)?.value
        // A sentence's full stop after an address is not part of it.
        val address = found?.trimEnd('.', ',', ')', ';', '!', '?')
        if (found == null || address == null) {
            return if (subject.isNotEmpty() && !text.startsWith(subject)) listOf(subject, text).filter { it.isNotEmpty() }.joinToString("\n") else text
        }
        val around = text.replace(found, " ").replace(Regex("\\s+"), " ").trim().trimEnd(':', '-', '–', '—').trim()
        val title = subject.takeIf { it.isNotEmpty() && it != address }
            ?: around.takeIf { it.isNotEmpty() }
            ?: hostOf(address)
        val rest = if (subject.isNotEmpty() && around.isNotEmpty() && around != subject) "\n$around" else ""
        return "$title\n<$address>$rest"
    }

    private fun hostOf(address: String): String =
        Uri.parse(address).host?.removePrefix("www.")?.takeIf { it.isNotEmpty() } ?: address
}
