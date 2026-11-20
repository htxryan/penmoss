package app.penmoss.analytics

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What one send came to (core's `SendOutcome`). */
sealed interface SendOutcome {
    data object Empty : SendOutcome

    data class Sent(val sent: Int, val refused: Int) : SendOutcome

    /** A 4xx: the batch was marked refused. */
    data class Refused(val refused: Int, val status: Int) : SendOutcome

    /** Offline, a timeout or a 5xx: kept, tried again later; [retryAfterMs] from a 429. */
    data class Retry(val status: Int?, val retryAfterMs: Long? = null) : SendOutcome
}

/** What Delete My Shared Data came to. */
enum class ForgetOutcome { OK, OFFLINE, FAILED }

/**
 * Sending (PEN-137, Local store and sending), as core's `sender.ts`: only waiting events, up to
 * 200, oldest first, in one batch of at most 64 KB, with a 10 s timeout. Offline, a 5xx or a
 * timeout keeps them; a 4xx marks the batch refused; 429 honours Retry-After. Never throws.
 */
class AnalyticsSender(
    http: OkHttpClient,
    /** The endpoint's base: BuildConfig's (t.penmoss.app), or a test's. */
    private val base: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val client = http.newBuilder()
        .callTimeout(AnalyticsFormat.SEND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .build()

    private fun url(path: String) = base().trim().trimEnd('/') + path

    /** Sends the next batch of waiting events under [install]. */
    suspend fun sendNext(store: AnalyticsStore, install: String): SendOutcome {
        val waiting = store.nextBatch(AnalyticsFormat.MAX_BATCH_EVENTS)
        if (waiting.isEmpty()) return SendOutcome.Empty
        val (body, events) = batchBody(install, waiting)
        val request = Request.Builder().url(url("/v1/batch")).post(body.toRequestBody(JSON)).build()
        return try {
            withContext(Dispatchers.IO) {
                client.newCall(request).await().use { response ->
                    val status = response.code
                    when {
                        status == 200 || status == 202 -> {
                            val refusedIndexes = runCatching {
                                ((Json.parseToJsonElement(response.body.string()) as JsonObject)["refused"] as? JsonArray)
                                    ?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }
                            }.getOrNull().orEmpty().toSet()
                            val refused = events.filterIndexed { index, _ -> index in refusedIndexes }.map { it.id }
                            val sent = events.filterIndexed { index, _ -> index !in refusedIndexes }.map { it.id }
                            store.mark(sent, refused, now())
                            store.setMeta(AnalyticsStore.LAST_BATCH, body)
                            store.setMeta(AnalyticsStore.LAST_BATCH_AT, now().toString())
                            SendOutcome.Sent(sent.size, refused.size)
                        }
                        status == 429 -> SendOutcome.Retry(status, retryAfter(response.header("Retry-After")))
                        status in 400..499 -> {
                            store.mark(emptyList(), events.map { it.id }, now())
                            SendOutcome.Refused(events.size, status)
                        }
                        else -> SendOutcome.Retry(status)
                    }
                }
            }
        } catch (error: IOException) {
            SendOutcome.Retry(null)
        } catch (error: IllegalArgumentException) {
            // An endpoint that is not a URL: nothing can be sent, so nothing is lost either.
            SendOutcome.Retry(null)
        }
    }

    /** Asks the server to delete everything shared under [install] (Delete My Shared Data). */
    suspend fun forget(install: String): ForgetOutcome {
        val body = buildJsonObject {
            put("v", JsonPrimitive(AnalyticsFormat.BATCH_VERSION))
            put("install", JsonPrimitive(install))
        }.toString()
        val request = try {
            Request.Builder().url(url("/v1/forget")).post(body.toRequestBody(JSON)).build()
        } catch (error: IllegalArgumentException) {
            return ForgetOutcome.FAILED
        }
        return try {
            withContext(Dispatchers.IO) {
                client.newCall(request).await().use { if (it.isSuccessful) ForgetOutcome.OK else ForgetOutcome.FAILED }
            }
        } catch (error: IOException) {
            ForgetOutcome.OFFLINE
        }
    }

    private fun retryAfter(header: String?): Long? {
        val text = header?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        text.toDoubleOrNull()?.let { seconds -> if (seconds >= 0) return minOf((seconds * 1000).toLong(), AnalyticsFormat.MAX_BACKOFF_MS) }
        return runCatching {
            val at = java.time.ZonedDateTime.parse(text, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
            (at - now()).coerceIn(0, AnalyticsFormat.MAX_BACKOFF_MS)
        }.getOrNull()
    }

    /** The call, cancelled with its coroutine: turning sharing off aborts a batch in flight. */
    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    if (continuation.isActive) continuation.resume(response) else response.close()
                }
            },
        )
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        /** The batch for [events], halved until its body is within 64 KB (core's `batchBody`). */
        fun batchBody(install: String, events: List<EventEntity>): Pair<String, List<EventEntity>> {
            var kept = events
            while (true) {
                val body = buildJsonObject {
                    put("v", JsonPrimitive(AnalyticsFormat.BATCH_VERSION))
                    put("install", JsonPrimitive(install))
                    put("events", JsonArray(kept.map { it.event().wire() }))
                }.toString()
                if (body.toByteArray().size <= AnalyticsFormat.MAX_BATCH_BYTES || kept.size <= 1) return body to kept
                kept = kept.take((kept.size + 1) / 2)
            }
        }
    }
}

/** The wait before the next try: a minute, doubling to an hour, reset by a success (core's `Backoff`). */
object SendBackoff {
    fun delay(outcome: SendOutcome, failures: Int): Long = when (outcome) {
        is SendOutcome.Retry -> outcome.retryAfterMs ?: minOf(AnalyticsFormat.SEND_EVERY_MS shl (failures - 1).coerceIn(0, 10), AnalyticsFormat.MAX_BACKOFF_MS)
        else -> AnalyticsFormat.SEND_EVERY_MS
    }
}
