package app.penmoss.engine.api

import java.io.File

/**
 * In-app feedback (T49, D41): where the outbox files a submission. Since T57 that is GitHub itself,
 * with the person's own token (A1010; the Penmoss server's `POST /api/feedback` went with T59).
 */
interface PenmossFeedbackApi {
    /**
     * Sends one submission: [payload] is the JSON part (`submissionId`, `type`, `priority`,
     * `title`, `description`, `version`, `context`), then each of [images] in order. Any answer
     * comes back as a [FeedbackAnswer]; no answer at all (offline, a timeout) is an IOException.
     */
    suspend fun sendFeedback(payload: String, images: List<FeedbackImage>): FeedbackAnswer
}

/** One screenshot part: its file, its type (`image/png` …) and its name (`screenshot-1.png`). */
data class FeedbackImage(val file: File, val contentType: String, val name: String)

/** What a submission was answered. */
sealed interface FeedbackAnswer {
    /** 201, or 200 for a repeat of one filed before (`duplicate`): the issue. */
    data class Filed(val number: Long, val url: String, val duplicate: Boolean) : FeedbackAnswer

    /** Any other answer: its status, the API's `error.code` and message, and `Retry-After` in ms. */
    data class Refused(val status: Int, val code: String?, val message: String, val retryAfterMs: Long? = null) : FeedbackAnswer
}
