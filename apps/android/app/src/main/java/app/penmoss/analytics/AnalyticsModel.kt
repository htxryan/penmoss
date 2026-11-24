package app.penmoss.analytics

import java.util.Locale

/*
 * Usage analytics' format on the phone (PEN-137), ported from core's `events.ts` and `limits.ts`:
 * an event's states, buckets and sizes, and the adjustable limits. `AnalyticsContractTest` checks
 * these against `apps/android/contract/analytics-v1.json`, which core writes.
 */

/** An event's state on the phone, set when it is recorded from the answer in force then. */
enum class EventState(val code: Int, val label: String) {
    /** No answer yet: sent only if the first answer is Yes. */
    PENDING(0, "Waiting for Your Answer"),

    /** Recorded under No: never leaves the phone. */
    LOCAL(1, "Not Shared"),

    /** Recorded under Yes: sent next. */
    WAITING(2, "Waiting to Send"),
    SENT(3, "Sent"),
    REFUSED(4, "Refused"),
    ;

    /** The name core and the CLI give it (`pending`, `local`, …). */
    val wire: String get() = name.lowercase(Locale.ROOT)

    companion object {
        fun of(code: Int): EventState = entries.firstOrNull { it.code == code } ?: LOCAL

        /** The order counts are written in: "Waiting to Send 2 · Sent 41 · Not Shared 212". */
        val ORDER = listOf(PENDING, WAITING, SENT, LOCAL, REFUSED)
    }
}

/** The person's answer: null until they give one. */
enum class ConsentAnswer(val wire: String) {
    YES("yes"),
    NO("no"),
    ;

    companion object {
        fun of(wire: String?): ConsentAnswer? = entries.firstOrNull { it.wire == wire }
    }
}

object AnalyticsFormat {
    const val BATCH_VERSION = 1
    const val MAX_BATCH_EVENTS = 200
    const val MAX_BATCH_BYTES = 64 * 1024
    const val SEND_EVERY_MS = 60_000L
    const val SEND_AT_WAITING = 25
    const val SEND_TIMEOUT_MS = 10_000L
    const val MAX_BACKOFF_MS = 60 * 60_000L

    val CLIENTS = listOf("mac", "android", "cli", "mcp")
    val ACTORS = listOf("person", "agent", "script")
    val CHANNELS = listOf("stable", "alpha", "dev")
    val OSES = listOf("macos", "android", "linux", "windows", "other")
    val SIZE_CLASSES = listOf("compact", "medium", "expanded")
    val KINDS = listOf("app", "command", "screen", "dialog", "click", "menu", "setting", "firstrun", "feedback", "sync", "cli", "tool", "scroll", "note", "input", "tree")

    val COUNT_BUCKETS = listOf("0", "1", "2–4", "5–9", "10–49", "50–99", "100–499", "500–999", "1000–4999", "5000+")
    private val COUNT_EDGES = listOf(5000 to "5000+", 1000 to "1000–4999", 500 to "500–999", 100 to "100–499", 50 to "50–99", 10 to "10–49", 5 to "5–9", 2 to "2–4", 1 to "1")

    /** The bucket a count falls in: counts are sent as buckets, never as numbers. */
    fun countBucket(count: Long): String {
        if (count <= 0) return "0"
        return COUNT_EDGES.firstOrNull { count >= it.first }?.second ?: "0"
    }

    val DURATION_BUCKETS = listOf("<1s", "1–2s", "2–5s", "5–15s", "15–60s", "1–5m", "5–30m", "30m+")
    private val DURATION_EDGES = listOf(
        30 * 60_000L to "30m+",
        5 * 60_000L to "5–30m",
        60_000L to "1–5m",
        15_000L to "15–60s",
        5_000L to "5–15s",
        2_000L to "2–5s",
        1_000L to "1–2s",
    )

    /** The bucket a duration in milliseconds falls in. */
    fun durationBucket(ms: Long): String {
        if (ms < 1000) return "<1s"
        return DURATION_EDGES.firstOrNull { ms >= it.first }?.second ?: "<1s"
    }

    val INSTALL = Regex("^[0-9a-f]{32}$")
    val SESSION = Regex("^[0-9a-f]{16}$")

    private val random = java.security.SecureRandom()

    private fun randomHex(bytes: Int): String {
        val buffer = ByteArray(bytes)
        random.nextBytes(buffer)
        return buffer.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** A new anonymous install id: 128 random bits. */
    fun newInstallId(): String = randomHex(16)

    /** A new session id: 64 random bits. */
    fun newSessionId(): String = randomHex(8)

    /** An OS version cut to major.minor ("15.1.2" → "15.1"), or "0" when unreadable. */
    fun majorMinor(version: String): String {
        val match = Regex("^(\\d{1,4})(?:\\.(\\d{1,4}))?").find(version.trim()) ?: return "0"
        val minor = match.groupValues[2]
        return if (minor.isEmpty()) match.groupValues[1] else "${match.groupValues[1]}.$minor"
    }

    /** The longest a window's side is recorded as (PEN-174), in dp. */
    const val MAX_LENGTH = 10_000

    /** A length as it is recorded: rounded to the nearest 10 and held to 0–[MAX_LENGTH]. */
    fun lengthOf(dp: Float): Int {
        if (dp.isNaN() || dp.isInfinite() || dp <= 0f) return 0
        return minOf(MAX_LENGTH, Math.round(dp / 10f) * 10)
    }

    /** The width class of a window [widthDp] wide. */
    fun sizeClassOf(widthDp: Int): String = when {
        widthDp < 600 -> "compact"
        widthDp < 840 -> "medium"
        else -> "expanded"
    }

    private val VERSION = Regex("^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[a-z0-9.]{1,20})?")

    /** The app's version as an event carries it: `0.2.1`, `0.2.1-alpha.1185`; `0.0.0` when unreadable. */
    fun eventVersion(version: String): String =
        VERSION.find(version.trim().lowercase(Locale.ROOT))?.value ?: Regex("^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}").find(version.trim())?.value ?: "0.0.0"

    /** Which channel a build is on: dev for a debug build, alpha for an Alpha build, else stable. */
    fun channelOf(version: String, debug: Boolean): String = when {
        debug -> "dev"
        app.penmoss.updates.alphaBuildOf(version) != null -> "alpha"
        else -> "stable"
    }

    /** "Waiting to Send 2 · Sent 41 · Not Shared 212": the counts by state, name first. */
    fun countsLine(counts: Map<EventState, Long>): String {
        val parts = EventState.ORDER.filter { (counts[it] ?: 0) > 0 }.map { "${it.label} ${number(counts[it] ?: 0)}" }
        return if (parts.isEmpty()) "Nothing Recorded Yet" else parts.joinToString(" · ")
    }

    /** A number as en-US writes it: 41,206. */
    fun number(value: Long): String = "%,d".format(Locale.US, value)
}

/** One limit: its default, range, unit and group (core's `LimitSpec`). */
data class LimitSpec(val key: String, val default: Int, val min: Int, val max: Int, val unit: String, val group: String) {
    /** "Between 1 and 360": what a field says of a value outside its range. */
    val rangeMessage: String get() = "Between ${AnalyticsFormat.number(min.toLong())} and ${AnalyticsFormat.number(max.toLong())}"

    /** "1–360 days": a field's range, written beside it. */
    val rangeLabel: String get() = "${AnalyticsFormat.number(min.toLong())}–${AnalyticsFormat.number(max.toLong())} $unit"

    fun allowed(value: Int): Boolean = value in min..max

    /** A value typed into its field: a whole number in range, or null. */
    fun parse(text: String): Int? {
        val trimmed = text.trim().replace(Regex("[,_\\s]"), "")
        if (!Regex("^\\d{1,7}$").matches(trimmed)) return null
        return trimmed.toInt().takeIf(::allowed)
    }
}

/**
 * The adjustable limits (O7, N8): how much usage record and log the phone keeps, and how much of
 * the log a bug report attaches. Every reader goes through [Limits.of], which falls back to the
 * default for a value that is missing or out of range.
 */
data class Limits(val values: Map<String, Int>) {
    operator fun get(key: String): Int = values[key] ?: spec(key).default

    val eventsDays: Int get() = this[EVENTS_DAYS]
    val eventsMax: Int get() = this[EVENTS_MAX]
    val logsFileKb: Int get() = this[LOGS_FILE_KB]
    val logsFiles: Int get() = this[LOGS_FILES]
    val logsDays: Int get() = this[LOGS_DAYS]
    val reportHoursSetting: Int get() = this[REPORT_HOURS]
    val reportLines: Int get() = this[REPORT_LINES]
    val reportKb: Int get() = this[REPORT_KB]

    /** How many hours of logs a bug report may attach: no more than the logs keep. */
    val reportHours: Int get() = minOf(reportHoursSetting, logsDays * 24)

    /** The most space the usage record takes, in bytes. */
    val eventSpace: Long get() = eventsMax.toLong() * EVENT_BYTES

    /** The most space the logs take, in bytes. */
    val logSpace: Long get() = logsFileKb.toLong() * 1024 * logsFiles

    /** Only the values that differ from their defaults, as the consent file keeps them. */
    val changed: Map<String, Int> get() = SPECS.filter { this[it.key] != it.default }.associate { it.key to this[it.key] }

    fun with(key: String, value: Int): Limits = of(values + (key to value))

    companion object {
        const val EVENTS_DAYS = "events.days"
        const val EVENTS_MAX = "events.max"
        const val LOGS_FILE_KB = "logs.fileKb"
        const val LOGS_FILES = "logs.files"
        const val LOGS_DAYS = "logs.days"
        const val REPORT_HOURS = "report.hours"
        const val REPORT_LINES = "report.lines"
        const val REPORT_KB = "report.kb"

        val SPECS = listOf(
            LimitSpec(EVENTS_DAYS, 7, 1, 360, "days", "usage"),
            LimitSpec(EVENTS_MAX, 200_000, 500, 2_000_000, "events", "usage"),
            LimitSpec(LOGS_FILE_KB, 1024, 256, 81_920, "KB", "logs"),
            LimitSpec(LOGS_FILES, 2, 1, 5, "files", "logs"),
            LimitSpec(LOGS_DAYS, 7, 1, 360, "days", "logs"),
            LimitSpec(REPORT_HOURS, 24, 1, 168, "hours", "report"),
            LimitSpec(REPORT_LINES, 300, 50, 2000, "lines", "report"),
            LimitSpec(REPORT_KB, 16, 4, 40, "KB", "report"),
        )

        val KEYS = SPECS.map { it.key }

        fun spec(key: String): LimitSpec = SPECS.first { it.key == key }

        /** About how many bytes one stored event takes with its indexes (PEN-177: a note's open averages about 4 KB). */
        const val EVENT_BYTES = 500L

        val DEFAULTS = Limits(SPECS.associate { it.key to it.default })

        /** The limits in force: each stored value when it is allowed, else its default. */
        fun of(stored: Map<String, Int?>): Limits =
            Limits(SPECS.associate { spec -> spec.key to (stored[spec.key]?.takeIf(spec::allowed) ?: spec.default) })

        /** Bytes as the Advanced section writes them: "2 MB", "400 MB", "640 KB" (core's `formatBytes`). */
        fun formatBytes(bytes: Long): String {
            if (bytes >= 1024 * 1024) {
                val mb = bytes / (1024.0 * 1024.0)
                val whole = mb == Math.floor(mb)
                return if (mb >= 10 || whole) "${Math.round(mb)} MB" else "${"%.1f".format(Locale.US, mb)} MB"
            }
            return "${maxOf(1L, Math.round(bytes / 1024.0))} KB"
        }
    }
}
