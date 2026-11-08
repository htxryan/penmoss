package app.penmoss.auth

import android.app.Activity
import android.app.Application
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/** What the owner check answered. */
sealed interface OwnerCheckResult {
    data object Confirmed : OwnerCheckResult

    /** Not confirmed: cancelled, failed, another check already open, or no screen lock. Says why. */
    data class Refused(val reason: String) : OwnerCheckResult
}

/**
 * The phone's check that its owner is there (D34, A503, A421; git notebooks' A855, A877):
 * BiometricPrompt with `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`, so a strong fingerprint or face,
 * or the screen lock's PIN, pattern or password where none is enrolled. There is never a weaker
 * check: a phone with no screen lock is refused and told how to set one.
 *
 * One check at a time: a second while one is open is refused, so nothing can queue prompts. The
 * words are Kotlin's own (`OwnerWords`), never a page's or a screen's.
 */
class PhoneOwnerCheck(
    /** Whether the phone can check its owner now. */
    private val availability: () -> Availability,
    /** Shows the prompt with these words; true once the owner has confirmed. */
    private val prompt: suspend (title: String, description: String) -> Boolean,
) {
    enum class Availability { READY, NO_SCREEN_LOCK, UNAVAILABLE }

    private val open = AtomicBoolean(false)

    /**
     * The check, with Kotlin's own words for what is about to happen (T50 G7, A855, A877): a git
     * notebook's repository, Remove, History's restore and Delete for good, from `OwnerWords`,
     * never a page's. "Penmoss is trying to <words>."
     */
    suspend fun confirmWords(words: String, live: () -> Boolean = { true }): OwnerCheckResult {
        // A check that fails in any way refuses: nothing is ever sent unchecked.
        val now = try {
            availability()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Availability.UNAVAILABLE
        }
        when (now) {
            Availability.READY -> Unit
            Availability.NO_SCREEN_LOCK -> return OwnerCheckResult.Refused(NO_SCREEN_LOCK)
            Availability.UNAVAILABLE -> return OwnerCheckResult.Refused(UNAVAILABLE)
        }
        if (!open.compareAndSet(false, true)) return OwnerCheckResult.Refused(ALREADY_OPEN)
        return try {
            // Right before the prompt: a request withdrawn meanwhile is never shown one (A887).
            if (!live()) return OwnerCheckResult.Refused(WITHDRAWN)
            if (prompt(TITLE, "Penmoss is trying to $words.")) OwnerCheckResult.Confirmed else OwnerCheckResult.Refused(NOT_CONFIRMED)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            OwnerCheckResult.Refused(UNAVAILABLE)
        } finally {
            open.set(false)
        }
    }

    companion object {
        const val TITLE = "Confirm it’s you"
        const val NOT_CONFIRMED = "this phone did not confirm it was you."
        const val NO_SCREEN_LOCK = "this phone has no screen lock. Set a PIN, pattern or password in Android’s Settings → Security, then try again."
        const val UNAVAILABLE = "this phone can’t check that it’s you right now."
        const val ALREADY_OPEN = "another check is already open."
        const val WITHDRAWN = "the request ran out before the prompt showed."
        const val AUTHENTICATORS = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

        /** The system's BiometricPrompt, over the activity on screen. */
        fun system(activities: ResumedActivity): PhoneOwnerCheck = PhoneOwnerCheck(
            availability = {
                val activity = activities.current()
                val manager = activity?.getSystemService(BiometricManager::class.java)
                when (manager?.canAuthenticate(AUTHENTICATORS)) {
                    BiometricManager.BIOMETRIC_SUCCESS -> Availability.READY
                    // With the screen lock allowed, "none enrolled" means no lock at all.
                    BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> Availability.NO_SCREEN_LOCK
                    else -> Availability.UNAVAILABLE
                }
            },
            prompt = { title, description ->
                val activity = activities.current()
                if (activity == null) false else systemPrompt(activity, title, description)
            },
        )

        private suspend fun systemPrompt(activity: Activity, title: String, description: String): Boolean =
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine { continuation ->
                    val signal = CancellationSignal()
                    continuation.invokeOnCancellation { signal.cancel() }
                    val callback = object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            if (continuation.isActive) continuation.resume(true)
                        }

                        // Cancelled, timed out, locked out, or the lock screen dismissed.
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (continuation.isActive) continuation.resume(false)
                        }
                    }
                    BiometricPrompt.Builder(activity)
                        .setTitle(title)
                        .setDescription(description)
                        .setAllowedAuthenticators(AUTHENTICATORS)
                        .build()
                        .authenticate(signal, activity.mainExecutor, callback)
                }
            }
    }
}

/** The activity on screen, for the prompt to show over; none while the app is in the background. */
class ResumedActivity : Application.ActivityLifecycleCallbacks {
    // Written on the main thread, read from wherever the check runs.
    @Volatile
    private var resumed: WeakReference<Activity>? = null

    fun current(): Activity? = resumed?.get()?.takeUnless { it.isFinishing || it.isDestroyed }

    override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
