package app.penmoss.ui.settings

import android.content.Context
import app.penmoss.DeviceGraph
import app.penmoss.analytics.Limits

/** Privacy's Logs row and Advanced's log limits, over the app's log writer (PEN-137). */
internal object PrivacyLogs {
    /** Share Log File (AC49): the scrubbed copy through the share sheet. */
    fun share(context: Context, device: DeviceGraph) {
        // Wired to app.penmoss.log.LogShare.
    }

    /** How many bytes of logs [limits] would delete now. */
    suspend fun outside(limits: Limits): Long = 0
}
