package app.penmoss.engine.tree

/**
 * Fractional order keys for manual sorting (T40 P4, NT7): a Kotlin port of
 * `packages/core/src/workspace/order.ts` (`keyBetween`), checked against its
 * golden vectors in [OrderKeysTest]. The phone computes optimistic keys for a
 * reorder made here; the server computes the authoritative key from its live
 * document, so a stale view never writes a stale key.
 */
object OrderKeys {
    private const val DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    private const val ZERO = '0'
    private const val LAST = 'z'
    private const val SMALLEST_INTEGER = "AZZZZZZZZZZZZZZZZZZZZZZZZZZ"

    /** Whether [key] is an order key the server could have made (T40 P4, NT7). */
    fun isValid(key: String): Boolean = runCatching { validateKey(key) }.isSuccess

    /** A key strictly between `before` and `after` (null: unbounded on that side). */
    fun keyBetween(before: String?, after: String?): String {        if (before != null) validateKey(before)
        if (after != null) validateKey(after)
        if (before != null && after != null && before >= after) {
            throw IllegalArgumentException("Order keys out of order: $before >= $after")
        }
        if (before == null) {
            if (after == null) return "a$ZERO"
            val intB = integerPart(after)
            val fracB = after.substring(intB.length)
            if (intB == SMALLEST_INTEGER) return intB + midpoint("", fracB)
            if (intB < after) return intB
            return decrementInteger(intB)
                ?: throw IllegalArgumentException("Cannot go below the smallest order key")
        }
        val intA = integerPart(before)
        val fracA = before.substring(intA.length)
        if (after == null) {
            val incremented = incrementInteger(intA)
            return incremented ?: intA + midpoint(fracA, null)
        }
        val intB = integerPart(after)
        val fracB = after.substring(intB.length)
        if (intA == intB) return intA + midpoint(fracA, fracB)
        val incremented = incrementInteger(intA)
            ?: throw IllegalArgumentException("Cannot go above the largest order key")
        return if (incremented < after) incremented else intA + midpoint(fracA, null)
    }

    private fun midpoint(a: String, b: String?): String {
        if (b != null && a >= b) throw IllegalArgumentException("Fractions out of order: $a >= $b")
        if (a.endsWith(ZERO) || (b != null && b.endsWith(ZERO))) throw IllegalArgumentException("Trailing zero")
        if (b != null) {
            var n = 0
            while ((a.getOrNull(n) ?: ZERO) == b.getOrNull(n)) n++
            if (n > 0) return b.substring(0, n) + midpoint(a.substring(n), b.substring(n))
        }
        val digitA = if (a.isEmpty()) 0 else DIGITS.indexOf(a[0])
        val digitB = if (b != null) DIGITS.indexOf(b[0]) else DIGITS.length
        if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2.0).toInt()].toString()
        if (b != null && b.length > 1) return b.substring(0, 1)
        return DIGITS[digitA] + midpoint(a.substring(1), null)
    }

    private fun integerLength(head: Char): Int {
        if (head in 'a'..'z') return head - 'a' + 2
        if (head in 'A'..'Z') return 'Z' - head + 2
        throw IllegalArgumentException("Invalid order key head: $head")
    }

    private fun integerPart(key: String): String {
        val length = integerLength(key.firstOrNull() ?: throw IllegalArgumentException("Invalid order key: $key"))
        if (length > key.length) throw IllegalArgumentException("Invalid order key: $key")
        return key.substring(0, length)
    }

    private fun validateKey(key: String) {
        if (key == SMALLEST_INTEGER) throw IllegalArgumentException("Invalid order key: $key")
        val integer = integerPart(key)
        for (char in key.substring(1)) {
            if (!DIGITS.contains(char)) throw IllegalArgumentException("Invalid order key: $key")
        }
        if (key.substring(integer.length).endsWith(ZERO)) throw IllegalArgumentException("Invalid order key: $key")
    }

    private fun incrementInteger(integer: String): String? {
        val head = integer[0]
        val digits = integer.substring(1).toMutableList()
        var carry = true
        for (i in digits.indices.reversed()) {
            if (!carry) break
            val next = DIGITS.indexOf(digits[i]) + 1
            if (next == DIGITS.length) digits[i] = ZERO
            else {
                digits[i] = DIGITS[next]
                carry = false
            }
        }
        if (!carry) return head + digits.joinToString("")
        if (head == 'Z') return 'a' + ZERO.toString()
        if (head == 'z') return null
        val nextHead = head + 1
        if (nextHead > 'a') digits.add(ZERO) else digits.removeLastOrNull()
        return nextHead + digits.joinToString("")
    }

    private fun decrementInteger(integer: String): String? {
        val head = integer[0]
        val digits = integer.substring(1).toMutableList()
        var borrow = true
        for (i in digits.indices.reversed()) {
            if (!borrow) break
            val next = DIGITS.indexOf(digits[i]) - 1
            if (next == -1) digits[i] = LAST
            else {
                digits[i] = DIGITS[next]
                borrow = false
            }
        }
        if (!borrow) return head + digits.joinToString("")
        if (head == 'a') return 'Z' + LAST.toString()
        if (head == 'A') return null
        val nextHead = head - 1
        if (nextHead < 'Z') digits.add(LAST) else digits.removeLastOrNull()
        return nextHead + digits.joinToString("")
    }
}
