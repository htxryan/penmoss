package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
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

/** What files and pictures take on this phone (ED12, ED13); null while it is counted. */
data class StorageUse(val files: Long, val webPictures: Long)

/**
 * Sync and storage's storage (T40 P8): the space notes' files and pictures take on this phone,
 * and pictures from web addresses: the per-device Load pictures from the web (On · Wi-Fi only ·
 * Off) and the cache they are kept in, which can be cleared.
 */
@Composable
fun StorageSection(
    use: StorageUse?,
    webPictures: WebPictureSetting,
    onWebPictures: (WebPictureSetting) -> Unit,
    onClearWebPictures: () -> Unit,
) {
    GroupTitle("Storage on this phone")
    ListItem(
        headlineContent = { Text("Files and pictures in notes") },
        supportingContent = { Text(use?.let { formatBytes(it.files) } ?: "Counting…", Modifier.testTag("storageFiles")) },
    )
    // The upload queue's own rule (review PS2): a large file is not sent over mobile data.
    Help("Files over 10 MB upload on Wi-Fi only.")
    ListItem(
        headlineContent = { Text("Pictures from the web") },
        supportingContent = { Text(use?.let { "${formatBytes(it.webPictures)} kept to show again" } ?: "Counting…", Modifier.testTag("storageWebPictures")) },
        trailingContent = {
            TextButton(onClick = onClearWebPictures, enabled = (use?.webPictures ?: 0) > 0, modifier = Modifier.testTag("clearWebPictures")) {
                Text("Clear")
            }
        },
    )
    GroupTitle("Load pictures from the web")
    Help(
        "Pictures in notes from web addresses are fetched by this phone, without your account. " +
            "Their sites can tell a note was opened, as on the web. With Wi-Fi only, they wait for a tap on mobile data.",
    )
    Column(Modifier.selectableGroup().padding(bottom = 8.dp)) {
        for (choice in WebPictureSetting.entries) {
            ChoiceRow(choice.label, null, webPictures == choice, enabled = true, tag = "webPictures-${choice.key}") { onWebPictures(choice) }
        }
    }
}
