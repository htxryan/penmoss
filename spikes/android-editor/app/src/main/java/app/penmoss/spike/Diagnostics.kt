package app.penmoss.spike

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Device info, export file and share sheet for the T2 diagnostics log. */
object Diagnostics {
    private const val CLIPBOARD_LIMIT = 400_000
    private const val CLIPBOARD_IME_TAIL = 3_000

    fun currentIme(activity: Activity): String =
        Settings.Secure.getString(activity.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) ?: "unknown"

    fun refreshRate(activity: Activity): Float = activity.display?.refreshRate ?: 0f

    fun deviceInfo(activity: Activity): JSONObject {
        val imm = activity.getSystemService(InputMethodManager::class.java)
        val webView = WebViewCompat.getCurrentWebViewPackage(activity)
        val metrics = activity.resources.displayMetrics
        return JSONObject()
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("device", Build.DEVICE)
            .put("androidRelease", Build.VERSION.RELEASE)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("securityPatch", Build.VERSION.SECURITY_PATCH)
            .put("webViewPackage", webView?.packageName ?: JSONObject.NULL)
            .put("webViewVersion", webView?.versionName ?: JSONObject.NULL)
            .put("defaultIme", currentIme(activity))
            .put("enabledImes", JSONArray(imm.enabledInputMethodList.map { it.id }))
            .put("displayRefreshHz", refreshRate(activity).toDouble())
            .put("screenPx", "${metrics.widthPixels}x${metrics.heightPixels}")
            .put("density", metrics.density.toDouble())
            .put("appVersion", activity.packageManager.getPackageInfo(activity.packageName, 0).versionName)
    }

    fun export(
        activity: Activity,
        mode: String,
        webPayload: String,
        timings: NativeTimings,
        frames: FrameStats,
    ) {
        val web = runCatching { JSONObject(webPayload) }.getOrElse { JSONObject().put("raw", webPayload) }
        val root = JSONObject()
            .put("kind", "penmoss-t2-android-editor-spike")
            .put("device", deviceInfo(activity))
            .put("native", JSONObject().put("coldOpen", timings.toJson()).put("frames", frames.toJson(refreshRate(activity))))
            .put("web", web)
        if (mode == "copy") copy(activity, root) else share(activity, root)
    }

    private fun share(activity: Activity, root: JSONObject) {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val dir = File(activity.cacheDir, "exports").apply { mkdirs() }
        val file = File(dir, "penmoss-t2-$stamp.json").apply { writeText(root.toString()) }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.exports", file)
        val summary = summaryLine(root)
        val send = Intent(Intent.ACTION_SEND)
            .setType("application/json")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, "Penmoss T2 spike log $stamp")
            .putExtra(Intent.EXTRA_TEXT, summary)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(file.name, uri)
        activity.startActivity(Intent.createChooser(send, "Export T2 log"))
    }

    private fun copy(activity: Activity, root: JSONObject) {
        var text = root.toString()
        if (text.length > CLIPBOARD_LIMIT) {
            // The clipboard goes through Binder (~1 MB); keep only the tail of the IME log.
            val ime = root.getJSONObject("web").optJSONObject("imeLog")
            val entries = ime?.optJSONArray("entries")
            if (ime != null && entries != null && entries.length() > CLIPBOARD_IME_TAIL) {
                val tail = JSONArray()
                for (i in entries.length() - CLIPBOARD_IME_TAIL until entries.length()) tail.put(entries.get(i))
                ime.put("entries", tail).put("truncatedForClipboard", true)
            }
            text = root.toString()
        }
        val clipboard = activity.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Penmoss T2 log", text))
        Toast.makeText(activity, "Copied ${text.length / 1024} KB. Use Share file for the full log.", Toast.LENGTH_LONG).show()
    }

    private fun summaryLine(root: JSONObject): String {
        val device = root.getJSONObject("device")
        val cold = root.getJSONObject("native").getJSONObject("coldOpen").opt("processStartToNotePaintedMs")
        val tests = root.getJSONObject("web").optJSONArray("typingTests")
        val results = buildString {
            if (tests != null) for (i in 0 until tests.length()) {
                val t = tests.getJSONObject(i)
                append("\n- ${t.optString("label")}: lost ${t.optInt("lost")}, duplicated ${t.optInt("duplicated")}, extra ${t.optInt("extra")}")
            }
        }
        return "Penmoss T2 spike log. ${device.optString("model")} (Android ${device.optString("androidRelease")}, WebView ${device.optString("webViewVersion")}). Cold open $cold ms.$results"
    }
}
