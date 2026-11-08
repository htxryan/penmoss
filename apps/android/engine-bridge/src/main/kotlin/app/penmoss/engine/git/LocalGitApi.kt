package app.penmoss.engine.git

import app.penmoss.engine.api.HttpPenmossApi
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException

/**
 * A git notebook's API on the phone (T50 G7, A874): `HttpPenmossApi`, unchanged, with an origin
 * no request can leave the phone for (`https://git.invalid/<localId>/`), and an OkHttp
 * interceptor that hands each request to the notebook's engine page instead of the network. So
 * Room's sync, the Senders, the note screens and the editor work for a git notebook, and nothing
 * about it leaves the phone but through git (A828).
 */
object LocalGitApi {
    const val HOST = "git.invalid"

    fun origin(localId: String): HttpUrl = "https://$HOST/$localId/".toHttpUrl()

    /**
     * The API for a notebook: [engine] is its page, opened when the first request comes. Delete for
     * good goes to the page, which asks the owner through [GitNotebooks.confirmPurge] in the
     * notebook's own words.
     */
    fun api(
        localId: String,
        base: OkHttpClient,
        asks: OwnerAsks,
        limits: Limits = Limits(),
        engine: suspend () -> GitEngine,
    ): HttpPenmossApi {
        val client = base.newBuilder()
            .apply { interceptors().clear(); networkInterceptors().clear() }
            // The interceptor bounds each request itself (A887): OkHttp's own call timeout would
            // cut a Delete for good short while the person is still being asked.
            .callTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .addInterceptor(Interceptor(localId, asks, limits, engine))
            .build()
        return HttpPenmossApi(origin(localId), client)
    }

    /**
     * How long a request may take (A887): [requestMs] of the notebook's own time; for one that
     * asks the person, the time they are asked does not count, up to [askedMs] in all; and once
     * they confirmed, [afterMs] more for the page to finish what they confirmed.
     */
    data class Limits(
        val requestMs: Long = GitEngine.HTTP_MS,
        val askedMs: Long = 10 * 60_000L,
        val afterMs: Long = GitEngine.HTTP_MS,
        val stepMs: Long = 250,
    )

    private class Interceptor(
        private val localId: String,
        private val asks: OwnerAsks,
        private val limits: Limits,
        private val engine: suspend () -> GitEngine,
    ) : okhttp3.Interceptor {
        private val prefix = "/$localId"

        override fun intercept(chain: okhttp3.Interceptor.Chain): Response {
            val request = chain.request()
            val url = request.url
            // Never anything but this notebook's own origin: nothing goes to the network.
            if (url.host != HOST || url.scheme != "https" || !url.encodedPath.startsWith("$prefix/")) {
                throw IOException("A git notebook's API answers only on ${origin(localId)}")
            }
            val path = url.encodedPath.removePrefix(prefix) + (url.encodedQuery?.let { "?$it" } ?: "")
            val body = request.body?.let { Buffer().also(it::writeTo).readByteArray() }
            val headers = buildMap {
                for ((name, value) in request.headers) put(name.lowercase(), value)
            }
            // An owner check the page may ask for, while this request of the app's runs (A877).
            val ask = askOf(request.method, url.encodedPath.removePrefix(prefix))?.let(asks::begin)
            val answer = try {
                runBlocking {
                    if (ask == null) {
                        withTimeout(limits.requestMs) { engine().http(request.method, path, headers, body) }
                    } else {
                        asking(ask) { engine().http(request.method, path, headers, body, timeoutMs = null) }
                    }
                }
            } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
                throw IOException("The notebook did not answer in time", error)
            } catch (error: GitChannelException) {
                throw IOException("The notebook could not answer: ${error.message}", error)
            } catch (error: GitRefusal) {
                throw IOException("The notebook could not open: ${error.message}", error)
            } finally {
                ask?.let { asks.end(it) }
            }
            val type = answer.headers["content-type"]?.toMediaTypeOrNull()
            val builder = Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(answer.status)
                .message(if (answer.status in 200..299) "OK" else "Error")
            for ((name, value) in answer.headers) builder.header(name, value)
            return builder.body(answer.body.toResponseBody(type)).build()
        }

        /**
         * A request that may ask the person (A887): its own time runs only while they are not
         * being asked. Out of time before they confirmed: withdrawn, so a later confirmation does
         * nothing, and the app says it failed. Confirmed: it goes on, and the page has
         * [Limits.afterMs] to finish it; past that the app cannot tell, and says so.
         */
        private suspend fun <T> asking(ask: OwnerAsks.Ask, call: suspend () -> T): T = kotlinx.coroutines.coroutineScope {
            val work = async { call() }
            val began = System.currentTimeMillis()
            var confirmedAt = -1L
            while (true) {
                val done = kotlinx.coroutines.withTimeoutOrNull(limits.stepMs) { work.await() }
                if (done != null || work.isCompleted) return@coroutineScope done ?: work.await()
                val now = System.currentTimeMillis()
                if (ask.committed) {
                    if (confirmedAt < 0) confirmedAt = now
                    if (now - confirmedAt > limits.afterMs) {
                        work.cancel()
                        throw IOException("The notebook did not answer after you confirmed. It may have done it: check before trying again.")
                    }
                    continue
                }
                val own = now - began - ask.promptedMs()
                if ((own > limits.requestMs || now - began > limits.askedMs) && ask.withdraw()) {
                    work.cancel()
                    throw IOException("The notebook did not answer in time, so nothing was done.")
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }

        private fun askOf(method: String, path: String): String? {
            PURGE.matchEntire(path)?.takeIf { method == "DELETE" }?.let { return OwnerAsks.purge(it.groupValues[1]) }
            RESTORE.matchEntire(path)?.takeIf { method == "POST" }?.let { return OwnerAsks.restore(it.groupValues[1], it.groupValues[2].toLong()) }
            return null
        }
    }

    private val PURGE = Regex("^/api/notes/([0-9A-Z]{26})$")
    private val RESTORE = Regex("^/api/notes/([0-9A-Z]{26})/versions/(\\d{1,15})/(?:restore|revert)$")
}
