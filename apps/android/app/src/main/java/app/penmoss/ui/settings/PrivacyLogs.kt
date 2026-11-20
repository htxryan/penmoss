package app.penmoss.ui.settings

import android.content.Context
import app.penmoss.DeviceGraph
import app.penmoss.analytics.Limits
import app.penmoss.feedback.ErrorScrub
import app.penmoss.log.LogShare
import app.penmoss.log.PenmossLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Privacy's Logs row and Advanced's log limits, over the app's log (PEN-137). */
internal object PrivacyLogs {
    /**
     * Share Log File (AC49): the kept files, scrubbed twice, through the share sheet. Scrub #2
     * also knows the open notebooks' note titles and folder, tag and file names.
     */
    suspend fun share(context: Context, device: DeviceGraph): Boolean {
        val names = withContext(Dispatchers.IO) {
            device.gitIfAny?.madeGraphs().orEmpty().flatMap { graph -> runCatching { graph.store.names() }.getOrDefault(emptyList()) }
        }
        val known = (PenmossLog.files?.known ?: ErrorScrub.Known()).withNames(names)
        return LogShare.share(context, known)
    }

    /** How many bytes of logs [limits] would delete now. */
    suspend fun outside(limits: Limits): Long = withContext(Dispatchers.IO) { PenmossLog.logsOutside(limits) }
}
