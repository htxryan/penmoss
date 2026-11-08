package app.penmoss.feedback

import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.feedback.FeedbackOutbox.Verdict
import app.penmoss.feedback.FeedbackValidation.Field
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The form's rules (T49): what must be filled in, what is sent, the images' sizes, and which answers are tried again. */
class FeedbackFormTest {
    private val draft = FeedbackDraft("01JBXYZ0000000000000000001")

    @Test
    fun typePriorityAndTitleAreRequiredWithNoDefault() {
        assertEquals(listOf(Field.TYPE, Field.PRIORITY, Field.TITLE), FeedbackValidation.problems(draft).map { it.field })
        assertEquals(
            "Can’t send yet: choose Bug report or Feature request; choose a priority; give it a title.",
            FeedbackValidation.summary(FeedbackValidation.problems(draft)),
        )
        val filled = draft.copy(type = "bug", priority = 2, title = "  Sync \n stalls  ")
        assertEquals(emptyList<FeedbackValidation.Problem>(), FeedbackValidation.problems(filled))
        assertNull(FeedbackValidation.summary(emptyList()))
        // Whitespace is not a title; one over the limit says by how much.
        assertEquals(listOf(Field.TITLE), FeedbackValidation.problems(filled.copy(title = " \t ")).map { it.field })
        val long = FeedbackValidation.problems(filled.copy(title = "x".repeat(258)))
        assertEquals("Keep the title to 256 characters.", long.single().message)
        val longer = FeedbackValidation.problems(filled.copy(description = "d".repeat(20_001)))
        assertEquals(listOf(Field.DESCRIPTION), longer.map { it.field })
        assertEquals("Keep the description to 20,000 characters (it has 20,001).", longer.single().message)
        assertEquals(listOf(Field.PRIORITY), FeedbackValidation.problems(filled.copy(priority = 5)).map { it.field })
    }

    @Test
    fun thePayloadCarriesTheContextThePreviewShowsWithoutTheGroupsLeftOut() {
        val context = FeedbackContextData(
            listOf(
                fieldGroup(FeedbackGroupId.APP, listOf("Client" to "Android")),
                fieldGroup(FeedbackGroupId.SYNC, listOf("Online" to false)),
                tableGroup(FeedbackGroupId.ERRORS, ERROR_COLUMNS, emptyList()),
            ),
        )
        val sent = draft.copy(type = "feature", priority = 4, title = " Dark  mode\tplease ", description = "**Please**", omitted = listOf("sync"))
        val payload = Json.parseToJsonElement(FeedbackPayload.of(sent, "0.31 (build 431425)", context)).jsonObject
        assertEquals("01JBXYZ0000000000000000001", payload.getValue("submissionId").jsonPrimitive.content)
        assertEquals("feature", payload.getValue("type").jsonPrimitive.content)
        assertEquals(4, payload.getValue("priority").jsonPrimitive.int)
        assertEquals("Dark mode please", payload.getValue("title").jsonPrimitive.content)
        assertEquals("**Please**", payload.getValue("description").jsonPrimitive.content)
        assertEquals("0.31 (build 431425)", payload.getValue("version").jsonPrimitive.content)
        val groups = Json.decodeFromJsonElement(FeedbackContextData.serializer(), payload.getValue("context"))
        // What is sent is exactly what the preview rendered.
        val preview = FeedbackUi(sent, context).sent
        assertEquals(preview, groups)
        assertEquals(listOf("app", "errors"), groups.groups.map { it.id })
        assertEquals(FeedbackMarkdown.context(preview), FeedbackMarkdown.context(groups))
    }

    @Test
    fun imagesAreScaledToTheLongSideAndOnlyPngStaysPng() {
        assertEquals(1080 to 2400, FeedbackImages.scaledSize(1080, 2400))
        assertEquals(2560 to 1920, FeedbackImages.scaledSize(4032, 3024))
        assertEquals(1440 to 2560, FeedbackImages.scaledSize(3024, 5376))
        assertEquals(2560 to 2560, FeedbackImages.scaledSize(4000, 4000))
        assertEquals(2560 to 1, FeedbackImages.scaledSize(10_000, 2))
        // Decoded at a power of two that stays at least as big as the target.
        assertEquals(1, FeedbackImages.sampleSize(4032, 3024))
        assertEquals(2, FeedbackImages.sampleSize(8000, 6000))
        assertEquals(4, FeedbackImages.sampleSize(12_000, 9_000))
        assertEquals(FeedbackImages.Encoding.PNG, FeedbackImages.encodingFor("image/png"))
        for (mime in listOf("image/jpeg", "image/webp", "image/gif")) assertEquals(FeedbackImages.Encoding.JPEG, FeedbackImages.encodingFor(mime))
        assertNull(FeedbackImages.refusal("image/webp", 10L * 1024 * 1024, 5))
        assertEquals("That image is over 10 MB", FeedbackImages.refusal("image/png", 10L * 1024 * 1024 + 1, 0))
        assertEquals("Screenshots must be PNG, JPEG, WebP or GIF images", FeedbackImages.refusal("image/heic", 10, 0))
        assertEquals("At most 6 screenshots", FeedbackImages.refusal("image/png", 10, 6))
    }

    @Test
    fun networkFailures5xx429AndInProgressAreTriedAgainAnyOther4xxIsFinal() {
        fun refused(status: Int, code: String? = null) = FeedbackAnswer.Refused(status, code, "m")
        assertEquals(Verdict.SENT, FeedbackOutbox.verdict(FeedbackAnswer.Filed(1, "https://github.com/htxryan/penmoss/issues/1", false)))
        for (status in listOf(500, 502, 503, 504)) assertEquals("$status", Verdict.RETRY, FeedbackOutbox.verdict(refused(status, "github_failed")))
        assertEquals(Verdict.RETRY, FeedbackOutbox.verdict(refused(429, "too_many_requests")))
        assertEquals(Verdict.RETRY, FeedbackOutbox.verdict(refused(409, "in_progress")))
        for ((status, code) in listOf(400 to "invalid_request", 401 to "unauthorized", 403 to "device_only", 404 to null, 409 to "submission_taken", 413 to "too_large", 424 to "github_refused")) {
            assertEquals("$status $code", Verdict.FINAL, FeedbackOutbox.verdict(refused(status, code)))
        }
    }

    @Test
    fun theFormSaysQueuedAndRefusedInItsWords() {
        assertEquals("Queued, will send when you’re online.", FeedbackFormModel.queuedMessage(FeedbackOutbox.OFFLINE))
        assertTrue(FeedbackFormModel.failedMessage(403, "Feedback comes from the Penmoss apps only.").endsWith("kept in Settings → About, where you can edit, retry or discard it."))
    }
}
