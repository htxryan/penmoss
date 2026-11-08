package app.penmoss.engine.notes

import java.security.SecureRandom

/**
 * Note ids as every client makes them (`@penmoss/core/ids`): a ULID, 48 bits of milliseconds and
 * 80 random bits in Crockford base32, so ids sort by creation time. The phone names a note it is
 * about to create (T38) before the editor page builds it, so the screen it opens on can be
 * reopened by id.
 */
object Ulid {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()

    fun next(now: Long = System.currentTimeMillis()): String {
        require(now in 0..0xFFFF_FFFF_FFFFL) { "time out of range" }
        val out = CharArray(26)
        var time = now
        for (i in 9 downTo 0) {
            out[i] = ALPHABET[(time and 31).toInt()]
            time = time ushr 5
        }
        val bytes = ByteArray(10).also(random::nextBytes)
        // 80 bits, five at a time.
        var bits = 0
        var buffer = 0
        var index = 10
        for (byte in bytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                out[index++] = ALPHABET[(buffer shr bits) and 31]
            }
        }
        return String(out)
    }
}
