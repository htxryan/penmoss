package app.penmoss.engine.git

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** Where frames go and come from: the WebView's `penmossNative`, or a Node process in the JVM tests. */
interface FramePort {
    fun send(frame: ByteArray)

    fun listen(listener: (ByteArray) -> Unit)

    fun close() {}
}

/** A call the other side refused or failed, as it said it (A824: the host's own words kept). */
class GitChannelException(val code: String, message: String, val hostMessage: String? = null) : Exception(message)

/** An answer: the value, and the frame its blobs are in. */
class GitAnswer(val value: JsonElement, private val frame: GitFrame) {
    fun bytes(value: JsonElement?): ByteArray? = frame.bytes(value)
}

/** A call from the other side: its arguments, the frame their blobs are in. */
class GitCall(val args: JsonElement, private val frame: GitFrame) {
    fun bytes(value: JsonElement?): ByteArray? = frame.bytes(value)
}

/** Answers one call: the reply's value, with any bytes put through [FrameBuilder.blob]. */
fun interface GitHandler {
    suspend fun answer(call: GitCall, reply: FrameBuilder): JsonElement
}

/**
 * Calls between the app and a git engine page (T50 G7, A873), Kotlin's side of
 * `editor/src/git/channel.ts`: `{k:'call', id, op, a}` answered by `{k:'ok', id, v}` or
 * `{k:'err', id, e}`, and `{k:'ev', n, v}` events. Handlers run in [scope] (off the WebView's
 * thread), and every call gets one answer, whatever its handler throws.
 */
class GitChannel(
    private val port: FramePort,
    private val scope: CoroutineScope,
    private val handlers: Map<String, GitHandler>,
    /** Told when an answer could not be sent: the page is gone (its port closed), nothing else to do. */
    private val onLost: (Throwable) -> Unit = { error -> System.err.println("[git] an answer to the page was lost: $error") },
) {
    private val next = AtomicLong(1)
    private val waiting = ConcurrentHashMap<Long, CompletableDeferred<GitAnswer>>()
    private val listeners = CopyOnWriteArrayList<(String, JsonElement) -> Unit>()

    init {
        port.listen(::receive)
    }

    /** Events the page sends (`status`, `changed`, `log`). */
    fun onEvent(listener: (name: String, value: JsonElement) -> Unit) {
        listeners += listener
    }

    /** Calls the page; [timeoutMs] fails it as `timeout` when no answer comes in time. */
    suspend fun call(op: String, timeoutMs: Long? = null, args: (FrameBuilder) -> JsonElement = { JsonNull }): GitAnswer {
        val id = next.getAndIncrement()
        val answer = CompletableDeferred<GitAnswer>()
        waiting[id] = answer
        try {
            val builder = FrameBuilder()
            val a = args(builder)
            port.send(builder.encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(id), "op" to JsonPrimitive(op), "a" to a))))
            return if (timeoutMs == null) {
                answer.await()
            } else {
                try {
                    withTimeout(timeoutMs) { answer.await() }
                } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
                    throw GitChannelException("timeout", "The git engine did not answer $op in time.")
                }
            }
        } finally {
            waiting.remove(id)
        }
    }

    /** Fails every call waiting for an answer: the page went away. */
    fun closeAll(reason: String) {
        for ((id, answer) in waiting) {
            waiting.remove(id)
            answer.completeExceptionally(GitChannelException("closed", reason))
        }
    }

    private fun receive(bytes: ByteArray) {
        val frame = try {
            GitFrame.decode(bytes)
        } catch (error: FrameException) {
            return
        }
        val header = frame.header
        val kind = header["k"].text()
        val id = (header["id"] as? JsonPrimitive)?.longOrNull
        when (kind) {
            "call" -> {
                val op = header["op"].text() ?: return
                if (id == null) return
                scope.launch { answer(id, op, GitCall(header["a"] ?: JsonNull, frame)) }
            }
            "ok" -> waiting.remove(id ?: return)?.complete(GitAnswer(header["v"] ?: JsonNull, frame))
            "err" -> {
                val error = header["e"] as? JsonObject
                waiting.remove(id ?: return)?.completeExceptionally(
                    GitChannelException(
                        error?.get("code").text() ?: "error",
                        error?.get("message").text() ?: "The call failed.",
                        error?.get("hostMessage").text(),
                    ),
                )
            }
            "ev" -> {
                val name = header["n"].text() ?: return
                for (listener in listeners) runCatching { listener(name, header["v"] ?: JsonNull) }
            }
        }
    }

    private suspend fun answer(id: Long, op: String, call: GitCall) {
        val handler = handlers[op]
        val reply = FrameBuilder()
        val header: JsonObject = if (handler == null) {
            failure(id, "unknown_call", "No such call: $op", null)
        } else {
            try {
                val value = handler.answer(call, reply)
                JsonObject(mapOf("k" to JsonPrimitive("ok"), "id" to JsonPrimitive(id), "v" to value))
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: GitException) {
                failure(id, error.code.wire, error.message ?: error.code.wire, error.hostMessage)
            } catch (error: GitChannelException) {
                failure(id, error.code, error.message ?: error.code, error.hostMessage)
            } catch (error: GitRefusal) {
                // The app's own checks (a public repository, an unconfirmed Delete for good): the
                // page shows the code and stops until the person acts.
                failure(id, error.code, error.message ?: error.code, error.hostMessage)
            } catch (error: Exception) {
                // An Error (out of memory, a broken invariant) is not answered: it goes on up.
                failure(id, "error", error.message ?: error::class.java.simpleName, null)
            }
        }
        val frame = try {
            reply.encode(header)
        } catch (error: FrameException) {
            FrameBuilder().encode(failure(id, "error", error.message ?: "The answer did not fit", null))
        }
        // The page may be gone by now (killed, its renderer dead, its port closed): the answer has
        // nowhere to go, and nothing waits for it here. Never thrown out of the call's coroutine,
        // where it would reach the scope's (or the thread's) uncaught handler.
        try {
            port.send(frame)
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Exception) {
            try {
                onLost(error)
            } catch (logging: Exception) {
                // Nothing more to tell.
            }
        }
    }

    private fun failure(id: Long, code: String, message: String, hostMessage: String?): JsonObject {
        val error = buildMap<String, JsonElement> {
            put("code", JsonPrimitive(code))
            put("message", JsonPrimitive(message))
            if (hostMessage != null) put("hostMessage", JsonPrimitive(hostMessage))
        }
        return JsonObject(mapOf("k" to JsonPrimitive("err"), "id" to JsonPrimitive(id), "e" to JsonObject(error)))
    }
}
