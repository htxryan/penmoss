package app.penmoss.ui.settings

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.editor.WebPictureSetting

/** A size for people, as core's `formatBytes`: `512 B`, `1.5 KB`, `20 MB`. */
fun formatBytes(bytes: Long): String {
    val units = listOf("B", "KB", "MB", "GB")
    var value = bytes.toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit++
    }
    val shown = if (unit == 0 || value >= 10) Math.round(value).toString() else (Math.round(value * 10) / 10.0).toString().removeSuffix(".0")
    return "$shown ${units[unit]}"
}

/** What files and pictures take on this phone (ED12, ED13): every notebook's files, and the web pictures kept. */
data class StorageUse(val files: Long, val webPictures: Long, val webPictureCount: Int = 0) {
    val total: Long get() = files + webPictures
}

/** Load Pictures From the Web's choices (PEN-146), in plain words, as Mode's are. */
internal val WEB_PICTURE_CHOICES = listOf(
    WebPictureSetting.ON.key to "Always",
    WebPictureSetting.WIFI_ONLY.key to "On Wi-Fi",
    WebPictureSetting.OFF.key to "Never",
)

/**
 * Settings → Storage (T40 P8, ED12, ED13; PEN-146 option B): this phone's storage, apart from any
 * notebook's sync. The space notes' files and pictures take in every notebook here; the pictures
 * from web addresses kept to show again, with Clear… (which asks first); and Load Pictures From
 * the Web, per device (A489).
 */
@Composable
fun StorageScreen(
    use: StorageUse?,
    webPictures: WebPictureSetting,
    onWebPictures: (WebPictureSetting) -> Unit,
    onClearWebPictures: () -> Unit,
    onBack: () -> Unit,
) {
    var clearing by rememberSaveable { mutableStateOf(false) }
    SectionScreen("Storage", onBack) {
        ListItem(
            modifier = Modifier.settingRow("files-and-pictures-in-notes"),
            headlineContent = { Text("Files and Pictures in Notes") },
            // The upload queue's own rule (review PS2): a large file is not sent over mobile data.
            supportingContent = { Text((use?.let { formatBytes(it.files) } ?: "Counting…") + " · files over 10 MB upload on Wi-Fi", Modifier.testTag("storageFiles")) },
        )
        ListItem(
            modifier = Modifier.settingRow("pictures-from-the-web"),
            headlineContent = { Text("Pictures from the Web") },
            supportingContent = {
                Text(
                    use?.let { "${it.webPictureCount} kept to show again · ${formatBytes(it.webPictures)}" } ?: "Counting…",
                    Modifier.testTag("storageWebPictures"),
                )
            },
            trailingContent = {
                TextButton(onClick = trackedClick("settings.storage.clear-web-pictures") { clearing = true }, enabled = (use?.webPictures ?: 0) > 0, modifier = Modifier.testTag("clearWebPictures")) {
                    Text("Clear…")
                }
            },
        )
        GroupTitle("Load Pictures from the Web", Modifier.settingRow("load-pictures-from-the-web"))
        Segments(WEB_PICTURE_CHOICES, webPictures.key, enabled = true, tag = "webPictures", event = "settings.storage.web-pictures") { key ->
            WebPictureSetting.entries.firstOrNull { it.key == key }?.let(onWebPictures)
        }
        Help(
            "Sites can tell a note was opened when a picture loads. Pictures in notes from web addresses are fetched by this phone; " +
                "with On Wi-Fi, they wait for a tap on mobile data.",
            Modifier.padding(top = 4.dp),
        )
    }
    if (clearing) {
        val tracked = rememberTrackedDialog("confirm")
        AlertDialog(
            onDismissRequest = { clearing = false },
            title = { Text("Clear Pictures from the Web?") },
            text = { Text("Penmoss fetches each one again the next time a note shows it. Your notes and their own files stay as they are.") },
            confirmButton = {
                TextButton(onClick = trackedClick("settings.storage.clear-web-pictures.confirm", tracked.done {
                    clearing = false
                    onClearWebPictures()
                }), modifier = Modifier.testTag("confirmClearWebPictures")) { Text("Clear", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = trackedClick("settings.storage.clear-web-pictures.cancel") { clearing = false }) { Text("Cancel") } },
        )
    }
}
