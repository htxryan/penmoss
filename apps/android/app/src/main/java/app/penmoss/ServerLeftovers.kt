package app.penmoss

import android.content.Context
import androidx.work.WorkManager

/**
 * What the Penmoss server's sign-in, error reports and background sync left on a phone that used
 * them before T59 (A1041), forgotten once at start: the sealed device token and its session, the
 * git mirror's last answer, error reports never sent, and the personal notes' WorkManager runs.
 * The notes the app's own database cached stay where they are: nothing shows them, and nothing
 * deletes a person's notes unasked.
 */
object ServerLeftovers {
    /** The preference files the sign-in, the mirror's cache and the personal notes' runs kept. */
    val PREFS = listOf("penmoss.session", "penmoss.vault", "penmoss.mirror", "penmoss.background")

    /** The personal notes' WorkManager runs (T35): the hourly one and the one after leaving the app. */
    val WORK = listOf("penmoss.sync.periodic", "penmoss.sync.whenOnline")

    private const val DONE = "penmoss.serverLeftovers"

    fun forget(context: Context) {
        val done = context.getSharedPreferences(DONE, Context.MODE_PRIVATE)
        if (done.getBoolean(DONE, false)) return
        val any = PREFS.any { java.io.File(context.dataDir, "shared_prefs/$it.xml").exists() }
        for (name in PREFS) context.deleteSharedPreferences(name)
        java.io.File(context.filesDir, "error-reports.json").delete()
        java.io.File(context.filesDir, "error-reports.json.tmp").delete()
        // WorkManager only where the personal notes' runs could be: a phone that never signed in
        // never had them, and WorkManager is not started for nothing.
        if (any) runCatching { WorkManager.getInstance(context).let { manager -> WORK.forEach(manager::cancelUniqueWork) } }
        done.edit().putBoolean(DONE, true).apply()
    }
}
