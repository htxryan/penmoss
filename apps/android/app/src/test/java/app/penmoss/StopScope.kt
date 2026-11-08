package app.penmoss

import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.robolectric.Shadows.shadowOf

/**
 * Cancels [scope] and waits until all of its work has ended (A690). Call it before closing the
 * scope's dispatcher and the database. `cancel()` alone returns at once, while a coroutine inside
 * a Room read finishes that read first: closing the database then fails the read after the
 * test, and kotlinx-coroutines-test reports it in a later class's `runTest` (SearchServiceTest
 * failed on NoteEditorController's load this way).
 */
fun stopScope(scope: CoroutineScope, timeoutMs: Long = 5_000) {
    runBlocking { withTimeout(timeoutMs) { scope.coroutineContext.job.cancelAndJoin() } }
}

/**
 * [stopScope] for a scope on the main thread under Robolectric (the app graph's,
 * `Dispatchers.Main.immediate`). Its coroutines end on the main looper, which only runs when the
 * test thread idles it, so this idles it until the scope's job has completed. Joining in
 * `runBlocking` instead would block that thread and never end.
 */
fun stopMainScope(scope: CoroutineScope, timeoutMs: Long = 5_000) {
    val job = scope.coroutineContext.job
    job.cancel()
    val deadline = System.nanoTime() + timeoutMs * 1_000_000
    val looper = shadowOf(Looper.getMainLooper())
    while (!job.isCompleted) {
        looper.idle()
        check(System.nanoTime() < deadline) { "The scope's work had not ended after $timeoutMs ms" }
        Thread.sleep(2)
    }
    looper.idle()
}
