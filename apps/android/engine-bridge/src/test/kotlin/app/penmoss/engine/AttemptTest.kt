package app.penmoss.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Review A11: a failure is the result, a cancellation is not swallowed. */
class AttemptTest {
    @Test
    fun aFailureIsTheResult() {
        val result = attempt { error("broke") }
        assertEquals("broke", result.exceptionOrNull()?.message)
        assertEquals(3, attempt { 3 }.getOrNull())
    }

    @Test
    fun aCancellationIsThrownOn() = runTest {
        var after = false
        val job = async {
            attempt { awaitCancellation() }
            after = true
        }
        yield()
        job.cancel()
        val thrown = runCatching { job.await() }.exceptionOrNull()
        assertTrue(thrown is CancellationException)
        // runCatching would have let the coroutine carry on past its cancelled call.
        assertFalse(after)
    }
}
