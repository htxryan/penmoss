package app.penmoss.ui

import app.penmoss.feedback.FeedbackFormModel
import app.penmoss.feedback.FeedbackOutbox
import app.penmoss.feedback.FeedbackOutboxEntity
import app.penmoss.feedback.outboxLine
import app.penmoss.git.handEditsText
import app.penmoss.sync.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * T39 pass 3: words the phone shares with the web and the Mac, as the web says them, with its
 * typography (curly apostrophes, A892–A895). Plain JVM: no screen.
 */
class WordingTest {
    @Test
    fun homesStatusLineHasCurlyApostrophes() {
        assertEquals("Offline: showing what’s on this phone", statusText(SyncStatus.Offline(1)))
        assertEquals(
            "Penmoss couldn’t sync just now and will try again. Showing what’s on this phone.",
            statusText(SyncStatus.Offline(1, serverError = true)),
        )
    }

    @Test
    fun feedbackSaysWhatTheWebSays() {
        val refused = FeedbackOutboxEntity("f1", "{}", "A bug", state = FeedbackOutboxEntity.FAILED, lastStatus = 403, lastError = "Devices only.")
        assertEquals("Not sent: Devices only (403).", outboxLine(refused) { "today" })
        val queued = FeedbackOutboxEntity("f2", "{}", "An idea", createdAt = 1)
        assertEquals("Queued today, will send when you’re online.", outboxLine(queued) { "today" })
        assertEquals("Queued, will send when you’re online.", FeedbackFormModel.queuedMessage(FeedbackOutbox.OFFLINE))
        assertEquals(
            "Not sent: Devices only (403). It’s kept in Settings → About, where you can edit, retry or discard it.",
            FeedbackFormModel.failedMessage(403, "Devices only."),
        )
    }

    @Test
    fun noneOfThemHasAStraightApostrophe() {
        val said = listOf(
            statusText(SyncStatus.Offline(1)),
            statusText(SyncStatus.Offline(1, serverError = true)),
            FeedbackFormModel.queuedMessage(FeedbackOutbox.OFFLINE),
            FeedbackFormModel.queuedMessage("Timed out"),
            FeedbackFormModel.failedMessage(null, "Refused"),
            handEditsText(listOf("a.md")),
            notebookDeleteText(1),
            notebookClosedMessage("Work"),
        )
        for (line in said) assertFalse(line, line.contains('\''))
    }
}
