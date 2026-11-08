package app.penmoss.engine.git

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The channel's answers when the page goes away (T50 G7, A873, the PR #167 review): a page killed
 * while the app still answers one of its calls. The answer has nowhere to go; it must never be
 * thrown out of the call's coroutine, where it reached the scope's handler (and, in the app, the
 * thread's: the app ended) and, in the JVM tests, failed an unrelated test.
 */
class GitChannelTest {
    /** A page's port whose stream closes, as NodePort's does once its process is killed. */
    private class DyingPort : FramePort {
        @Volatile
        var dead = false
        lateinit var app: (ByteArray) -> Unit
        val sent = CopyOnWriteArrayList<ByteArray>()

        override fun send(frame: ByteArray) {
            if (dead) throw IOException("Stream Closed")
            sent += frame
        }

        override fun listen(listener: (ByteArray) -> Unit) {
            app = listener
        }

        fun call(id: Int, op: String) =
            app(FrameBuilder().encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(id), "op" to JsonPrimitive(op), "a" to JsonNull))))
    }

    @Test
    fun aPageThatDiesWhileTheAppAnswersLosesTheAnswerAndNothingElse() = runBlocking {
        val uncaught = CopyOnWriteArrayList<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error -> uncaught += error })
        val port = DyingPort()
        val lost = CopyOnWriteArrayList<Throwable>()
        val answering = CountDownLatch(1)
        val release = CompletableDeferred<Unit>()
        val answered = CountDownLatch(2)
        GitChannel(
            port,
            scope,
            mapOf(
                "slow" to GitHandler { _, _ ->
                    answering.countDown()
                    release.await()
                    JsonPrimitive("late")
                },
                "quick" to GitHandler { _, _ -> JsonPrimitive("now") },
            ),
            onLost = { error ->
                lost += error
                answered.countDown()
            },
        )
        port.call(1, "slow")
        assertTrue(answering.await(10, TimeUnit.SECONDS))
        // The page is killed while the app is still working on its call.
        port.dead = true
        release.complete(Unit)
        // And a call that came just before it died, answered after.
        port.call(2, "quick")
        assertTrue("both answers were lost quietly", answered.await(10, TimeUnit.SECONDS))
        withTimeout(5_000) { while (lost.size < 2) kotlinx.coroutines.delay(10) }
        assertEquals(listOf("Stream Closed", "Stream Closed"), lost.map { it.message })
        assertTrue("thrown out of the call: $uncaught", uncaught.isEmpty())
        assertTrue(port.sent.isEmpty())
        scope.cancel()
    }

    @Test
    fun withoutAnOnLostTheDefaultLogsAndStillThrowsNothing() = runBlocking {
        val uncaught = CopyOnWriteArrayList<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error -> uncaught += error })
        val port = DyingPort().apply { dead = true }
        val done = CountDownLatch(1)
        GitChannel(port, scope, mapOf("quick" to GitHandler { _, _ -> JsonPrimitive("now").also { done.countDown() } }))
        port.call(1, "quick")
        assertTrue(done.await(10, TimeUnit.SECONDS))
        // Give the answer's send its moment.
        kotlinx.coroutines.delay(200)
        assertTrue("thrown out of the call: $uncaught", uncaught.isEmpty())
        scope.cancel()
    }

    @Test
    fun anErrorIsNeverAnsweredOrSwallowedItGoesOnUp() = runBlocking {
        val uncaught = CopyOnWriteArrayList<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error -> uncaught += error })
        val port = DyingPort()
        val lost = CopyOnWriteArrayList<Throwable>()
        GitChannel(
            port,
            scope,
            mapOf(
                "broken" to GitHandler { _, _ -> throw AssertionError("a broken invariant") },
                "failing" to GitHandler { _, _ -> throw IllegalStateException("an ordinary failure") },
            ),
            onLost = { lost += it },
        )
        // An Exception is the page's answer, as before.
        port.call(1, "failing")
        withTimeout(5_000) { while (port.sent.isEmpty()) kotlinx.coroutines.delay(10) }
        // An Error is not: it reaches the scope's handler, and the page gets nothing for it.
        port.call(2, "broken")
        withTimeout(5_000) { while (uncaught.isEmpty()) kotlinx.coroutines.delay(10) }
        assertEquals("a broken invariant", uncaught.single().message)
        assertEquals(1, port.sent.size)
        assertTrue(lost.isEmpty())
        scope.cancel()
    }

    @Test
    fun anErrorWhileSendingIsNotTakenForALostAnswer() = runBlocking {
        val uncaught = CopyOnWriteArrayList<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error -> uncaught += error })
        val lost = CopyOnWriteArrayList<Throwable>()
        val port = object : FramePort {
            var app: ((ByteArray) -> Unit)? = null

            override fun send(frame: ByteArray) = throw OutOfMemoryError("no room for the answer")

            override fun listen(listener: (ByteArray) -> Unit) {
                app = listener
            }
        }
        GitChannel(port, scope, mapOf("quick" to GitHandler { _, _ -> JsonPrimitive("now") }), onLost = { lost += it })
        port.app!!(FrameBuilder().encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(1), "op" to JsonPrimitive("quick"), "a" to JsonNull))))
        withTimeout(5_000) { while (uncaught.isEmpty()) kotlinx.coroutines.delay(10) }
        assertTrue(uncaught.single() is OutOfMemoryError)
        assertTrue(lost.isEmpty())
        scope.cancel()
    }
}
