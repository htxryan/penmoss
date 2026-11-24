package app.penmoss.log

import android.content.Context
import app.penmoss.analytics.Limits
import app.penmoss.feedback.ErrorScrub
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * The phone's log (PEN-137, Local logs): `filesDir/logs/penmoss.log` and the files rotated from it
 * (`penmoss.1.log` the newest of those), written whatever the analytics answer. Every line is
 * scrubbed when it is written (scrub #1, [ErrorScrub.scrubber]) and starts with its time,
 * `2026-11-19T11:54:16.525Z warn <tag> <message>`; a stack's lines follow without one. The files
 * keep to the limits: rotated by size up to the file count, and lines older than the days trimmed
 * hourly, never on the main thread. A log leaves the phone only when it is attached to a bug
 * report ([reportLines]) or shared ([shareableCopy]), scrubbed again with the open notebooks'
 * names (scrub #2).
 */
class PenmossLogFiles(
    val dir: File,
    /** Where a shared copy goes: the only folder the `.logs` FileProvider exposes. */
    val shareDir: File,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Volatile
    var limits: Limits = Limits.DEFAULTS

    /** What scrub #1 knows: the login, the notebooks, their repositories and branches. */
    @Volatile
    var known: ErrorScrub.Known = ErrorScrub.Known()

    val current: File get() = File(dir, CURRENT)

    /** The kept files, oldest first. */
    fun files(): List<File> {
        val rotated = (dir.listFiles().orEmpty()).mapNotNull { file -> ROTATED.matchEntire(file.name)?.groupValues?.get(1)?.toIntOrNull()?.let { it to file } }
            .sortedByDescending { it.first }
            .map { it.second }
        return rotated + listOfNotNull(current.takeIf { it.isFile })
    }

    /** Writes one entry (on the writer's thread): scrubbed, with the stack's first frames after it. */
    fun append(level: String, tag: String, message: String, error: Throwable? = null) {
        val scrubber = ErrorScrub.scrubber(known)
        val lines = mutableListOf(scrubber.line("${iso(now())} $level $tag $message"))
        if (error != null) {
            lines += scrubber.line("  ${error::class.java.name}: ${error.message.orEmpty()}")
            error.stackTrace.take(MAX_FRAMES).forEach { lines += scrubber.line("    at $it") }
            var cause = error.cause
            var depth = 0
            while (cause != null && cause !== error && depth < 3) {
                lines += scrubber.line("  Caused by: ${cause::class.java.name}: ${cause.message.orEmpty()}")
                cause.stackTrace.take(3).forEach { lines += scrubber.line("    at $it") }
                cause = cause.cause
                depth++
            }
        }
        write(lines.joinToString("\n", postfix = "\n"))
    }

    @Synchronized
    private fun write(text: String) {
        dir.mkdirs()
        val bytes = text.toByteArray()
        val max = limits.logsFileKb * 1024L
        if (current.isFile && current.length() > 0 && current.length() + bytes.size > max) rotate()
        current.appendBytes(bytes)
    }

    /** penmoss.log becomes penmoss.1.log, and so on; the oldest beyond the count goes. */
    fun rotate() {
        val keep = limits.logsFiles
        val rotated = files().filter { it != current }.reversed() // newest first: penmoss.1.log …
        for ((index, file) in rotated.withIndex().reversed()) {
            val n = index + 1
            if (n + 1 > keep - 1) file.delete() else file.renameTo(File(dir, "penmoss.${n + 1}.log"))
        }
        if (keep <= 1) current.delete() else current.renameTo(File(dir, "penmoss.1.log"))
    }

    /** What the limits leave of each file: deleted (null) or kept from a byte offset. */
    private fun plan(limits: Limits, now: Long): List<Pair<File, Long?>> {
        val all = files()
        val kept = all.takeLast(limits.logsFiles)
        val out = (all - kept.toSet()).map { it to null as Long? }.toMutableList()
        val cutoff = now - limits.logsDays * DAY
        var fresh = false
        val offsets = kept.associateWith { 0L }.toMutableMap()
        for (file in kept) {
            if (fresh) break
            val first = firstLineFrom(file, cutoff)
            if (first == null) {
                offsets[file] = -1L
            } else {
                offsets[file] = first
                fresh = true
            }
        }
        val max = limits.logsFileKb * 1024L
        for (file in kept) {
            var offset = offsets.getValue(file)
            if (offset < 0) {
                out += file to (if (file == current) file.length() else null)
                continue
            }
            if (file.length() - offset > max) offset = nextLineStart(file, file.length() - max)
            out += file to offset
        }
        return out
    }

    /** How many bytes of logs [limits] would delete now (for "Delete 38 MB of Logs?"). */
    fun outside(limits: Limits, now: Long = now()): Long =
        plan(limits, now).sumOf { (file, offset) -> offset ?: file.length() }

    /** Deletes what falls outside [limits]: whole files, or a file's oldest lines by streaming copy. */
    fun prune(limits: Limits = this.limits, now: Long = now()) {
        for ((file, offset) in plan(limits, now)) {
            when {
                offset == null -> file.delete()
                offset >= file.length() && offset > 0 -> file.writeBytes(ByteArray(0))
                offset > 0 -> headTrim(file, offset)
            }
        }
    }

    private fun headTrim(file: File, offset: Long) {
        val temp = File(file.parentFile, "${file.name}.trim")
        RandomAccessFile(file, "r").use { input ->
            input.seek(offset)
            temp.outputStream().use { output ->
                val buffer = ByteArray(CHUNK)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                }
            }
        }
        if (!temp.renameTo(file)) {
            temp.copyTo(file, overwrite = true)
            temp.delete()
        }
    }

    /** The offset of the first line at or after [cutoff], or null when every timed line is older. */
    private fun firstLineFrom(file: File, cutoff: Long): Long? {
        // A line without a time (a stack's) is as fresh as the line before it.
        var lastFresh = false
        file.inputStream().buffered().use { input ->
            val line = java.io.ByteArrayOutputStream()
            var start = 0L
            var position = 0L
            fun fresh(): Boolean {
                val time = lineTime(line.toString(Charsets.UTF_8))
                if (time != null) lastFresh = time >= cutoff
                return lastFresh
            }
            while (true) {
                val byte = input.read()
                if (byte == -1) break
                position++
                if (byte == '\n'.code) {
                    if (fresh()) return start
                    line.reset()
                    start = position
                } else {
                    line.write(byte)
                }
            }
            if (line.size() > 0 && fresh()) return start
        }
        return null
    }

    private fun nextLineStart(file: File, from: Long): Long {
        RandomAccessFile(file, "r").use { input ->
            input.seek(from)
            var position = from
            while (true) {
                val byte = input.read()
                if (byte == -1) return position
                position++
                if (byte == '\n'.code) return position
            }
        }
    }

    /** Every kept line, newest first, read backwards in 64 KB chunks across the files. */
    fun linesNewestFirst(): Sequence<String> = sequence {
        for (file in files().reversed()) yieldAll(backwards(file))
    }

    /**
     * The lines a bug report attaches (core's `reportLines` after scrub #2): the newest from the
     * last hours the limits allow, at most `report.lines` lines and `report.kb` KB. Only the end
     * of the files is read.
     */
    fun reportLines(limits: Limits = this.limits, now: Long = now(), known: ErrorScrub.Known = this.known): List<String> {
        val since = now - limits.reportHours * HOUR
        val raw = mutableListOf<String>()
        var rawBytes = 0L
        for (line in linesNewestFirst()) {
            if (line.isEmpty()) continue
            val time = lineTime(line)
            if (time != null && time < since) break
            if (raw.size >= limits.reportLines || rawBytes > limits.reportKb * 1024L * 2 + CHUNK) break
            raw += line
            rawBytes += line.toByteArray().size + 1
        }
        val scrubber = ErrorScrub.scrubber(known)
        val scrubbed = raw.asReversed().map(scrubber::line)
        return select(scrubbed, limits, now)
    }

    /**
     * A copy of every kept file, oldest first, scrubbed again (scrub #2), in
     * `cacheDir/share/penmoss-log.txt`: the one file Share Log File hands over, replaced each time.
     */
    fun shareableCopy(known: ErrorScrub.Known = this.known): File {
        shareDir.mkdirs()
        val target = File(shareDir, SHARE_NAME)
        val temp = File(shareDir, "$SHARE_NAME.part")
        val scrubber = ErrorScrub.scrubber(known)
        temp.bufferedWriter().use { out ->
            for (file in files()) {
                file.bufferedReader().useLines { lines -> lines.forEach { out.write(scrubber.line(it)); out.write("\n") } }
            }
        }
        target.delete()
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
            temp.delete()
        }
        return target
    }

    /** The shared copy goes at the next start. */
    fun clearShared() {
        File(shareDir, SHARE_NAME).delete()
        File(shareDir, "$SHARE_NAME.part").delete()
    }

    companion object {
        const val CURRENT = "penmoss.log"
        const val SHARE_NAME = "penmoss-log.txt"
        const val CHUNK = 64 * 1024
        const val DAY = 86_400_000L
        const val HOUR = 3_600_000L
        private const val MAX_FRAMES = 8
        private val ROTATED = Regex("^penmoss\\.(\\d+)\\.log$")
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val TIME = Regex("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z)[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]")

        fun iso(time: Long): String = ISO.format(Instant.ofEpochMilli(time))

        /** A line's time: it starts with its ISO time (core's `lineTime`); null for a stack's line. */
        fun lineTime(line: String): Long? {
            val match = TIME.find(line) ?: return null
            return runCatching { Instant.parse(match.groupValues[1]).toEpochMilli() }.getOrNull()
        }

        /**
         * Core's `reportLines`: from [lines] (oldest first), those from the last hours the limits
         * allow, then the newest that fit the line and byte limits. A line without a time belongs
         * to the line before it.
         */
        fun select(lines: List<String>, limits: Limits, now: Long): List<String> {
            val since = now - limits.reportHours * HOUR
            val maxBytes = limits.reportKb * 1024L
            val kept = mutableListOf<String>()
            var bytes = 0L
            for (index in lines.indices.reversed()) {
                val line = lines[index]
                if (line.isEmpty()) continue
                val time = lineTime(line)
                if (time != null && time < since) break
                val size = line.toByteArray().size + 1
                if (kept.size >= limits.reportLines || bytes + size > maxBytes) break
                kept += line
                bytes += size
            }
            return kept.asReversed().toList()
        }

        /** [file]'s lines, newest first, read from its end in 64 KB chunks. */
        fun backwards(file: File): Sequence<String> = sequence {
            if (!file.isFile) return@sequence
            RandomAccessFile(file, "r").use { input ->
                var position = input.length()
                var carry = ByteArray(0)
                val buffer = ByteArray(CHUNK)
                var first = true
                while (position > 0) {
                    val size = minOf(CHUNK.toLong(), position).toInt()
                    position -= size
                    input.seek(position)
                    input.readFully(buffer, 0, size)
                    val chunk = buffer.copyOf(size) + carry
                    var end = chunk.size
                    for (index in chunk.indices.reversed()) {
                        if (chunk[index] == '\n'.code.toByte()) {
                            val line = String(chunk, index + 1, end - index - 1, Charsets.UTF_8)
                            // The file's last newline ends its last line: no empty line after it.
                            if (!(first && end == chunk.size && line.isEmpty())) yield(line)
                            first = false
                            end = index
                        }
                    }
                    carry = chunk.copyOf(end)
                }
                if (carry.isNotEmpty()) yield(String(carry, Charsets.UTF_8))
            }
        }
    }
}

/**
 * The app's log (PEN-137): anything can write to it, from any thread. Lines are appended by one
 * thread of their own, never the main thread; until [install] (and in tests that install none) it
 * only forwards to Android's log.
 */
object PenmossLog {
    @Volatile
    var files: PenmossLogFiles? = null
        private set

    private var writer: ScheduledExecutorService? = null

    /** Starts the log in `filesDir/logs/`; the last shared copy in `cacheDir/share/` goes. */
    fun install(context: Context, limits: Limits = Limits.DEFAULTS) {
        install(PenmossLogFiles(File(context.filesDir, "logs"), File(context.cacheDir, "share")), limits)
    }

    @Synchronized
    fun install(log: PenmossLogFiles, limits: Limits = Limits.DEFAULTS) {
        log.limits = limits
        files = log
        val thread = writer ?: Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "penmoss-log").apply { isDaemon = true } }
        writer = thread
        thread.execute { runCatching { log.clearShared() } }
        // Age is enforced hourly, off the main thread (N14), and once at start.
        thread.scheduleWithFixedDelay({ runCatching { files?.prune() } }, 0, 1, TimeUnit.HOURS)
        installCrashHandler()
    }

    /** What scrub #1 knows from now on: the login, the notebooks, their repositories and branches. */
    fun known(known: ErrorScrub.Known) {
        files?.known = known
    }

    /** New limits: kept, and what falls outside them deleted on the log's thread. */
    fun applyLimits(limits: Limits) {
        val log = files ?: return
        log.limits = limits
        onThread { log.prune(limits) }
    }

    fun info(tag: String, message: String, error: Throwable? = null) = log("info", tag, message, error)

    fun warn(tag: String, message: String, error: Throwable? = null) = log("warn", tag, message, error)

    fun error(tag: String, message: String, error: Throwable? = null) = log("error", tag, message, error)

    private fun log(level: String, tag: String, message: String, error: Throwable?) {
        runCatching {
            when (level) {
                "error" -> android.util.Log.e(tag, message, error)
                "warn" -> android.util.Log.w(tag, message, error)
                else -> android.util.Log.i(tag, message, error)
            }
        }
        val log = files ?: return
        onThread { log.append(level, tag, message, error) }
    }

    private fun onThread(work: () -> Unit) {
        runCatching { writer?.execute { runCatching(work) } }
    }

    /** Waits for what was asked of the log's thread so far (tests, and before a share). */
    fun drain(timeoutMs: Long = 5_000) {
        val thread = writer ?: return
        runCatching { thread.submit {}.get(timeoutMs, TimeUnit.MILLISECONDS) }
    }

    /** The lines a bug report attaches now; off the main thread. */
    fun reportLines(limits: Limits, now: Long, known: ErrorScrub.Known): List<String> {
        drain()
        return files?.reportLines(limits, now, known).orEmpty()
    }

    /** The shared copy (Share Log File); off the main thread. Null when there is no log. */
    fun shareableCopy(known: ErrorScrub.Known): File? {
        drain()
        return files?.shareableCopy(known)
    }

    /** How many bytes of logs [limits] would delete now. */
    fun logsOutside(limits: Limits, now: Long = System.currentTimeMillis()): Long {
        drain()
        return files?.outside(limits, now) ?: 0L
    }

    @Volatile
    private var crashHandler = false

    /** An uncaught error is written, synchronously, before the app goes. */
    private fun installCrashHandler() {
        if (crashHandler) return
        crashHandler = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { files?.append("error", "Penmoss", "Uncaught on ${thread.name}", error) }
            previous?.uncaughtException(thread, error)
        }
    }
}
