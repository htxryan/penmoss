package app.penmoss.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A bug report's logs block is core's `log-block.ts` byte for byte (PEN-137, AC7): its summary
 * and fence, the sizes the form shows, and the body cut from the oldest line to stay inside the
 * Linear intake's 60,000 characters. `FeedbackMarkdownTest` checks a whole body against core's.
 */
class FeedbackLogsBlockTest {
    @Test
    fun theBlockIsCollapsedFencedAndCounted() {
        assertEquals("", FeedbackLogs.block(emptyList()))
        assertEquals(
            "<details>\n<summary>Anonymised Logs (1 line)</summary>\n\n```text\none\n```\n\n</details>",
            FeedbackLogs.block(listOf("one")),
        )
        // A fence no line can close: one longer than any run of backticks.
        val block = FeedbackLogs.block(listOf("a ```` b", "c"))
        assertTrue(block.contains("\n`````text\na ```` b\nc\n`````\n"))
        assertTrue(block.contains("<summary>Anonymised Logs (2 lines)</summary>"))
    }

    @Test
    fun sizesAreWrittenAsCoreWritesThem() {
        assertEquals("512 B", FeedbackLogs.formatReportSize(512))
        assertEquals("9.6 KB", FeedbackLogs.formatReportSize(9630))
        assertEquals("1 KB", FeedbackLogs.formatReportSize(1000))
        assertEquals("16 KB", FeedbackLogs.formatReportSize(16_000))
        assertEquals(7, FeedbackLogs.textBytes(listOf("é", "abcd")))
    }

    @Test
    fun theOldestLinesGoUntilTheBlockFits() {
        val lines = (0 until 5_000).map { "2026-11-19T11:54:16.525Z info line $it ${"x".repeat(40)}" }
        val kept = FeedbackLogs.linesThatFit(lines, others = 10_000)
        assertTrue(kept.isNotEmpty())
        assertEquals(lines.last(), kept.last())
        assertTrue(FeedbackLogs.block(kept).length + 2 <= 60_000 - 10_000 - 400)
        // One more of the dropped lines would not fit: exactly as core's one-at-a-time loop.
        val oneMore = lines.subList(lines.size - kept.size - 1, lines.size)
        assertTrue(FeedbackLogs.block(oneMore).length + 2 > 60_000 - 10_000 - 400)
        assertEquals(lines.takeLast(3), FeedbackLogs.linesThatFit(lines.takeLast(3), others = 100))
    }

    @Test
    fun anIssueBodyWithHugeLogsStaysUnderTheIntakeLimit() {
        val logs = (0 until 2_000).map { "2026-11-19T11:54:16.525Z warn sync ${"y".repeat(100)} $it" }
        val body = FeedbackMarkdown.issueBody(
            description = "z".repeat(19_000),
            screenshots = emptyList(),
            context = FeedbackContextData(listOf(fieldGroup(FeedbackGroupId.APP, listOf("Client" to "Android")))),
            client = "android",
            version = "0.40 (build 440)",
            submissionId = "01JBXYZ0000000000000000004",
            logs = logs,
        )
        assertTrue(body.length < 60_000)
        assertTrue(body.contains("<summary>Anonymised Logs ("))
        assertTrue(body.trimEnd().endsWith("submission 01JBXYZ0000000000000000004"))
        assertTrue(body.indexOf("Anonymised Logs") < body.indexOf("Sent from Penmoss"))
    }
}
