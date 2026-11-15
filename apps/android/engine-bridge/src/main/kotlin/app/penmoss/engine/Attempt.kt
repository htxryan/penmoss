package app.penmoss.engine

import kotlin.coroutines.cancellation.CancellationException

/**
 * [runCatching] for work that may suspend (architecture review A11): a failure is the result, but
 * a cancellation is thrown on, so a coroutine whose screen or scope went stops there instead of
 * carrying on as though its call had failed. Plain [runCatching] stays for parsing and other work
 * that never suspends.
 */
inline fun <T> attempt(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Throwable) {
        Result.failure(failure)
    }
