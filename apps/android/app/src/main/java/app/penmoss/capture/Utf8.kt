package app.penmoss.capture

/** Text cut by its size in UTF-8 bytes, as the server counts it (T34, A347). */
object Utf8 {
    /** The bytes `text` takes in UTF-8. */
    fun size(text: String): Int {
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val point = text.codePointAt(i)
            bytes += bytesOf(point)
            i += Character.charCount(point)
        }
        return bytes
    }

    /** `text`, or its start that fits in `maxBytes`: never half a character or a surrogate pair. */
    fun cut(text: String, maxBytes: Int): String {
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val point = text.codePointAt(i)
            val next = bytes + bytesOf(point)
            if (next > maxBytes) return text.substring(0, i)
            bytes = next
            i += Character.charCount(point)
        }
        return text
    }

    private fun bytesOf(point: Int): Int = when {
        point < 0x80 -> 1
        point < 0x800 -> 2
        // A lone surrogate is written as U+FFFD, three bytes.
        point < 0x10000 -> 3
        else -> 4
    }
}
