package app.penmoss

import java.io.InputStream

/** [size] zero bytes, read without ever being held whole: for files near the 50 MB limit. */
class Zeros(size: Long) : InputStream() {
    private var left = size

    /** The most read in one call: what any reader can hold of it at once. */
    var largestRead = 0
        private set

    override fun read(): Int {
        if (left <= 0) return -1
        left--
        return 0
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val count = minOf(len.toLong(), left).toInt()
        b.fill(0, off, off + count)
        left -= count
        largestRead = maxOf(largestRead, count)
        return count
    }
}
