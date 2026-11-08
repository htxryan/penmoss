package app.penmoss.feedback

/**
 * The last errors this run of the app met (T49, A791): an error the editor page reports and a
 * sync pass that failed for a reason other than being offline, oldest first, at most [capacity].
 * In memory only, never written to a file or sent as they are: the feedback form reads them
 * through [ErrorScrub] ([FeedbackContextBuilder.errors]). Since T59 nothing else collects them:
 * the error reports Penmoss's server kept went with it.
 */
class RecentErrors(
    private val capacity: Int = FeedbackLimits.RECENT,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** One error as it was met: its kind (words of the app's own), its free text and its stack. */
    data class Entry(val at: Long, val fixed: String, val free: String, val detail: String)

    private val entries = ArrayDeque<Entry>()

    /** Records [error]: its kind, its message and its stack. */
    fun report(error: Throwable) = add(error::class.java.simpleName.ifEmpty { "Throwable" }, error.message.orEmpty(), error.stackTraceToString())

    /** Records an error that is only a message, such as the editor page's. */
    fun report(message: String) = add("", message, "")

    fun add(fixed: String, free: String, detail: String) = synchronized(entries) {
        entries.addLast(Entry(now(), fixed, free, detail))
        while (entries.size > capacity) entries.removeFirst()
    }

    /** Oldest first. */
    fun all(): List<Entry> = synchronized(entries) { entries.toList() }

    fun clear() = synchronized(entries) { entries.clear() }
}
