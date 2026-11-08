package app.penmoss.auth

import app.penmoss.auth.PhoneOwnerCheck.Availability
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone's owner check (T40 P2a, D34, A421; git notebooks' A855, A877) with the system prompt
 * replaced: BiometricPrompt can't be answered under Robolectric, so both of its answers are given
 * here instead.
 */
class PhoneOwnerCheckTest {
    private companion object {
        /** A git notebook's words for the check (`OwnerWords`). */
        const val WORDS = "remove the git notebook Work from this phone"
        const val OTHER = "delete 2 notes for good"
    }

    private val asked = mutableListOf<Pair<String, String>>()

    private fun check(availability: Availability, answer: suspend () -> Boolean = { true }) =
        PhoneOwnerCheck({ availability }) { title, description ->
            asked += title to description
            answer()
        }

    @Test
    fun aConfirmedPromptAllowsTheChangeInKotlinsWords() = runBlocking {
        assertEquals(OwnerCheckResult.Confirmed, check(Availability.READY).confirmWords(WORDS))
        assertEquals(listOf(PhoneOwnerCheck.TITLE to "Penmoss is trying to $WORDS."), asked)
    }

    @Test
    fun aRequestWithdrawnBeforeThePromptShowsIsNeverShownOne() = runBlocking {
        // A git notebook's Delete for good whose request ran out while the check opened (A887).
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.WITHDRAWN), check(Availability.READY).confirmWords("delete 1 note for good") { false })
        assertEquals(emptyList<Pair<String, String>>(), asked)
        // Still live: asked as before, and the next check can open.
        assertEquals(OwnerCheckResult.Confirmed, check(Availability.READY).confirmWords("delete 1 note for good") { true })
        assertEquals(1, asked.size)
    }

    @Test
    fun aCancelledOrFailedPromptRefuses() = runBlocking {
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.NOT_CONFIRMED), check(Availability.READY) { false }.confirmWords(WORDS))
        assertEquals(1, asked.size)
    }

    @Test
    fun aPhoneWithNoScreenLockIsRefusedWithoutAPromptAndNeverConfirmsOnly() = runBlocking {
        val result = check(Availability.NO_SCREEN_LOCK).confirmWords(WORDS)
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.NO_SCREEN_LOCK), result)
        // No fallback that only asks: nothing was shown, nothing confirmed.
        assertEquals(emptyList<Pair<String, String>>(), asked)
    }

    @Test
    fun aPhoneThatCannotCheckNowIsRefused() = runBlocking {
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.UNAVAILABLE), check(Availability.UNAVAILABLE).confirmWords(WORDS))
        assertEquals(emptyList<Pair<String, String>>(), asked)
    }

    @Test
    fun aCheckThatFailsRefusesRatherThanLettingTheChangeThrough() = runBlocking {
        // As on the emulator before the manifest asked for USE_BIOMETRIC: the system threw.
        val throwing = PhoneOwnerCheck({ throw SecurityException("Must have USE_BIOMETRIC permission") }) { _, _ -> true }
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.UNAVAILABLE), throwing.confirmWords(WORDS))
        val promptThrows = PhoneOwnerCheck({ Availability.READY }) { _, _ -> throw IllegalStateException("no window") }
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.UNAVAILABLE), promptThrows.confirmWords(WORDS))
        // And the next check can still open.
        assertEquals(OwnerCheckResult.Confirmed, PhoneOwnerCheck({ Availability.READY }) { _, _ -> true }.confirmWords(WORDS))
    }

    @Test
    fun oneCheckAtATime() = runBlocking {
        val answer = CompletableDeferred<Boolean>()
        val owner = check(Availability.READY) { answer.await() }
        val first = async { owner.confirmWords(WORDS) }
        yield()
        // A second while the first is open is refused, so prompts can't queue up.
        assertEquals(OwnerCheckResult.Refused(PhoneOwnerCheck.ALREADY_OPEN), owner.confirmWords(OTHER))
        answer.complete(true)
        assertEquals(OwnerCheckResult.Confirmed, first.await())
        // Once closed, the next can open.
        assertEquals(OwnerCheckResult.Confirmed, check(Availability.READY).confirmWords(OTHER))
        assertEquals(1, asked.count { it.second.contains(WORDS) })
    }

    @Test
    fun theSystemCheckAsksForAStrongBiometricOrTheScreenLock() {
        assertEquals(
            android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            PhoneOwnerCheck.AUTHENTICATORS,
        )
    }
}
