package app.penmoss.log

import app.penmoss.analytics.Limits
import app.penmoss.feedback.ErrorScrub
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The phone's log (PEN-137, AC22, AC28, AC35's correctness twin): lines scrubbed when written,
 * rotated by size up to the count, trimmed by age, a report's lines read from the end within the
 * limits (non-default ones too), and the shared copy scrubbed again, oldest first, replaced.
 */
class PenmossLogTest {
    @get:Rule val folder = TemporaryFolder()

    private var clock = T0
    private fun log(limits: Limits = Limits.DEFAULTS): PenmossLogFiles =
        PenmossLogFiles(folder.newFolder("logs"), File(folder.root, "share")) { clock }.also { it.limits = limits }

    private fun line(at: Long, text: String) = "${PenmossLogFiles.iso(at)} info Test $text"

    @Test
    fun linesStartWithTheirTimeAndAreScrubbedWhenWritten() {
        val log = log()
        log.known = ErrorScrub.Known(login = "lemurcanary", notebooks = listOf("Wombatcanary Notebook"))
        log.append("warn", "Git", "push as lemurcanary to Wombatcanary Notebook with ghp_CANARY000000000000000000000000000000 at /Users/someone/x.md")
        val text = log.current.readText()
        assertEquals(
            "${PenmossLogFiles.iso(T0)} warn Git push as ‹login› to ‹notebook-1› with ‹token› at ‹path›\n",
            text,
        )
        assertEquals(T0, PenmossLogFiles.lineTime(text.lines().first()))
    }

    @Test
    fun anErrorsStackFollowsWithoutATime() {
        val log = log()
        log.append("error", "Sync", "failed", IllegalStateException("bad \"Zebracanary Title\""))
        val lines = log.current.readLines()
        assertTrue(lines.size > 2)
        assertTrue(lines[1], lines[1].contains("IllegalStateException") && lines[1].contains("‹text›"))
        assertTrue(lines.drop(1).all { PenmossLogFiles.lineTime(it) == null })
    }

    @Test
    fun rotatesBySizeUpToTheFileCount() {
        val limits = Limits.DEFAULTS.with(Limits.LOGS_FILE_KB, 256).with(Limits.LOGS_FILES, 3)
        val log = log(limits)
        val filler = "x".repeat(1000)
        repeat(1200) { log.append("info", "Test", "$it $filler") }
        val files = log.files()
        assertEquals(listOf("penmoss.2.log", "penmoss.1.log", "penmoss.log"), files.map { it.name })
        assertTrue(files.all { it.length() <= 256 * 1024 })
        // The newest line is in the current file, and the oldest kept is in penmoss.2.log.
        assertTrue(log.current.readLines().last().contains(" 1199 "))
        val first = files.first().readLines().first().substringAfter("Test ").substringBefore(' ').toInt()
        assertTrue(first > 0)
    }

    @Test
    fun oneFileKeptMeansRotationStartsAgain() {
        val log = log(Limits.DEFAULTS.with(Limits.LOGS_FILE_KB, 256).with(Limits.LOGS_FILES, 1))
        repeat(600) { log.append("info", "Test", "$it ${"y".repeat(1000)}") }
        assertEquals(listOf("penmoss.log"), log.files().map { it.name })
    }

    @Test
    fun ageTrimsOldFilesAndTheOldestLinesOfTheRest() {
        val log = log(Limits.DEFAULTS.with(Limits.LOGS_DAYS, 2))
        log.dir.mkdirs()
        File(log.dir, "penmoss.2.log").writeText(line(T0 - 5 * DAY, "ancient") + "\n")
        File(log.dir, "penmoss.1.log").writeText(line(T0 - 3 * DAY, "old") + "\n  at stack.frame\n" + line(T0 - DAY, "fresh") + "\n  at fresh.frame\n")
        log.current.writeText(line(T0, "now") + "\n")
        val before = log.files().sumOf { it.length() }
        val outside = log.outside(log.limits, T0)
        assertTrue(outside > 0)
        log.prune(log.limits, T0)
        assertEquals(before - outside, log.files().sumOf { it.length() })
        assertEquals(listOf("penmoss.1.log", "penmoss.log"), log.files().map { it.name })
        assertEquals(listOf(line(T0 - DAY, "fresh"), "  at fresh.frame"), File(log.dir, "penmoss.1.log").readLines())
        // Raising a limit never brings anything back.
        assertEquals(0L, log.outside(Limits.DEFAULTS.with(Limits.LOGS_DAYS, 360), T0))
    }

    @Test
    fun loweringTheFileCountOrSizeCountsWhatGoes() {
        val log = log()
        log.dir.mkdirs()
        File(log.dir, "penmoss.1.log").writeText(line(T0, "a".repeat(100)) + "\n")
        log.current.writeText((1..400).joinToString("") { line(T0, "b".repeat(1000)) + "\n" })
        val rotated = File(log.dir, "penmoss.1.log").length()
        assertEquals(rotated, log.outside(Limits.DEFAULTS.with(Limits.LOGS_FILES, 1), T0))
        val smaller = log.outside(Limits.DEFAULTS.with(Limits.LOGS_FILE_KB, 256), T0)
        assertTrue(smaller >= log.current.length() - 256 * 1024)
        log.prune(Limits.DEFAULTS.with(Limits.LOGS_FILE_KB, 256), T0)
        assertTrue(log.current.length() <= 256 * 1024)
        assertTrue(log.current.readLines().all { PenmossLogFiles.lineTime(it) != null })
    }

    @Test
    fun aReportReadsTheNewestLinesWithinItsLimits() {
        val log = log()
        log.dir.mkdirs()
        File(log.dir, "penmoss.1.log").writeText((0 until 200).joinToString("") { line(T0 - 30 * HOUR + it, "older $it") + "\n" })
        log.current.writeText((0 until 400).joinToString("") { line(T0 - 400 + it, "recent $it") + "\n" })
        val lines = log.reportLines(Limits.DEFAULTS, T0, ErrorScrub.Known())
        // 24 hours, 300 lines at most: the newest 300 of the current file.
        assertEquals(300, lines.size)
        assertTrue(lines.last().endsWith("recent 399"))
        assertTrue(lines.first().endsWith("recent 100"))
        // Report limits that are not the defaults: 50 lines.
        val fifty = log.reportLines(Limits.DEFAULTS.with(Limits.REPORT_LINES, 50), T0, ErrorScrub.Known())
        assertEquals(50, fifty.size)
        assertTrue(fifty.last().endsWith("recent 399"))
        // 4 KB at most.
        val small = log.reportLines(Limits.DEFAULTS.with(Limits.REPORT_KB, 4), T0, ErrorScrub.Known())
        assertTrue(small.sumOf { it.toByteArray().size + 1 } <= 4 * 1024)
        // The last 48 hours reach into the rotated file, oldest first.
        val more = log.reportLines(Limits.DEFAULTS.with(Limits.REPORT_HOURS, 48).with(Limits.REPORT_LINES, 2000).with(Limits.REPORT_KB, 40), T0, ErrorScrub.Known())
        assertTrue(more.size > 400)
        assertTrue(more.first().contains("older"))
        // Never more hours than the logs keep.
        assertEquals(24, Limits.DEFAULTS.with(Limits.REPORT_HOURS, 168).with(Limits.LOGS_DAYS, 1).reportHours)
    }

    @Test
    fun aReportIsScrubbedAgainWithTheNotebooksNames() {
        val log = log()
        log.dir.mkdirs()
        log.current.writeText(line(T0 - 10, "opened Zebracanary Title Q7") + "\n" + line(T0 - 5, "tagged #narwhalcanary") + "\n")
        val lines = log.reportLines(Limits.DEFAULTS, T0, ErrorScrub.Known(names = listOf("Zebracanary Title Q7", "narwhalcanary")))
        assertEquals(listOf(line(T0 - 10, "opened ‹name›"), line(T0 - 5, "tagged #‹name›")), lines)
    }

    @Test
    fun theBackwardsReaderCrossesChunksAndKeepsUtf8Whole() {
        val file = folder.newFile("big.log")
        val lines = (0 until 5000).map { "line $it ✓ é ${"z".repeat(it % 50)}" }
        file.writeText(lines.joinToString("\n", postfix = "\n"))
        assertEquals(lines.reversed(), PenmossLogFiles.backwards(file).toList())
        val unterminated = folder.newFile("u.log")
        unterminated.writeText("a\nb")
        assertEquals(listOf("b", "a"), PenmossLogFiles.backwards(unterminated).toList())
    }

    @Test
    fun theSharedCopyIsEveryFileOldestFirstScrubbedAgainAndReplaced() {
        val log = log()
        log.dir.mkdirs()
        File(log.dir, "penmoss.1.log").writeText(line(T0 - 10, "first Okapicanary Folder") + "\n")
        log.current.writeText(line(T0, "second") + "\n")
        val copy = log.shareableCopy(ErrorScrub.Known(names = listOf("Okapicanary Folder")))
        assertEquals(File(log.shareDir, "penmoss-log.txt"), copy)
        assertEquals(listOf(line(T0 - 10, "first ‹name›"), line(T0, "second")), copy.readLines())
        log.current.writeText(line(T0, "third") + "\n")
        val again = log.shareableCopy()
        assertEquals(copy, again)
        assertTrue(again.readText().contains("third"))
        assertFalse(again.readText().contains("second"))
        log.clearShared()
        assertFalse(copy.exists())
    }

    @Test
    fun theReportSelectionMatchesCore() {
        val limits = Limits.DEFAULTS.with(Limits.REPORT_LINES, 50)
        val input = listOf(line(T0 - 25 * HOUR, "too old"), line(T0 - 10, "kept"), "  at a.stack", "", line(T0, "last"))
        assertEquals(listOf(line(T0 - 10, "kept"), "  at a.stack", line(T0, "last")), PenmossLogFiles.select(input, limits, T0))
    }

    private companion object {
        const val T0 = 1_795_000_000_000L
        const val HOUR = 3_600_000L
        const val DAY = 24 * HOUR
    }
}
