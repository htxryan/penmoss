package app.penmoss.analytics

/** A [Settle] the test fires itself: what waits, and for how long it was asked to. */
class FakeSettle : Settle {
    var pending: (() -> Unit)? = null
        private set
    var delayMs: Long? = null
        private set

    override fun after(delayMs: Long, run: () -> Unit) {
        this.delayMs = delayMs
        pending = run
    }

    override fun cancel() {
        pending = null
        delayMs = null
    }

    /** The wait ends: what waited runs. */
    fun fire() {
        val run = pending
        cancel()
        run?.invoke()
    }
}
