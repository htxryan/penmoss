package app.penmoss.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.roles

// --- Quick Capture (ST7; PEN-146) ---

/**
 * Quick Capture (ST7; PEN-146): where the capture sheet, the tile, the widget and sharing start,
 * and the notebook they file in, the primary one (A1101), which All Notebooks changes.
 */
@Composable
fun QuickCaptureScreen(
    destination: String,
    enabled: Boolean,
    onChoose: (String) -> Unit,
    onBack: () -> Unit,
    /** The primary notebook's name, where captures go; null with no notebook yet. */
    notebook: String? = null,
    onNotebook: () -> Unit = {},
    /** No notebook on the phone: nothing holds these yet. */
    noNotebook: Boolean = false,
) {
    SectionScreen("Quick Capture", onBack, notice = settingsWait(noNotebook).takeIf { !enabled }) {
        GroupTitle("Saves To", Modifier.settingRow("saves-to"))
        Column(Modifier.selectableGroup()) {
            ChoiceRow("Today’s Note", "At the end of ## Captures, with the time", destination == "daily", enabled, "capture-daily", event = "settings.quick-capture.destination") { onChoose("daily") }
            ChoiceRow("New Note in Inbox", "Titled by its first line", destination == "inbox", enabled, "capture-inbox", event = "settings.quick-capture.destination") { onChoose("inbox") }
        }
        Help("The capture sheet starts on this, and lets you pick the other for one capture.")
        GroupTitle("Notebook")
        ListItem(
            headlineContent = { Text(notebook ?: "No Notebook Yet") },
            supportingContent = { Text(if (notebook != null) "Your primary notebook · change it on All Notebooks" else "Add one on All Notebooks") },
            trailingContent = { Text("›", style = MaterialTheme.roles.rowLabel) },
            modifier = Modifier.testTag("captureNotebook").clickable(role = Role.Button, onClick = trackedClick("settings.quick-capture.notebook-link", onNotebook)),
        )
    }
}
