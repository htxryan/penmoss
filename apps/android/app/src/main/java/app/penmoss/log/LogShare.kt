package app.penmoss.log

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.feedback.ErrorScrub
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Share Log File's provider (PEN-137, AC49): an authority of its own, `${applicationId}.logs`,
 * exposing only `cacheDir/share/` (`res/xml/log_paths.xml`), where the scrubbed copy is written.
 */
class LogFileProvider : FileProvider()

/**
 * Settings → Privacy → Share Log File (PEN-137, AC49): the log's scrubbed copy
 * ([PenmossLogFiles.shareableCopy]) handed to Android's share sheet, as plain text, readable
 * once by the app chosen.
 */
object LogShare {
    fun authority(context: Context) = "${context.packageName}.logs"

    /** The content URI of the shared copy [file]; throws for a file outside `cacheDir/share/`. */
    fun uriOf(context: Context, file: File): Uri = FileProvider.getUriForFile(context, authority(context), file)

    /** The chooser, titled "Share Log File", wrapping ACTION_SEND of [file]. */
    fun intent(context: Context, file: File): Intent {
        val uri = uriOf(context, file)
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(file.name, uri)
        return Intent.createChooser(send, AnalyticsCopy.text("privacy.logs.button"))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    /** Makes the copy off the main thread (scrub #2 with [known]), then opens the share sheet. False with no log. */
    suspend fun share(context: Context, known: ErrorScrub.Known): Boolean {
        val file = withContext(Dispatchers.IO) { PenmossLog.shareableCopy(known) } ?: return false
        val intent = intent(context, file)
        if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }
}
