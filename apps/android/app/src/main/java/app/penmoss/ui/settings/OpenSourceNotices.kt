package app.penmoss.ui.settings

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.penmoss.engine.settings.Notices

/**
 * Open Source Notices (A1580): a link in the version card on Settings → What's New, the phone's
 * page with the version (the Mac has it under the version on Settings → Updates). It shows the
 * notices (`third-party-notices.txt`: Lucide's licence and the Characters' notice) in a dialog.
 * In the card, so this version's notes still start on the first screen.
 */
@Composable
internal fun OpenSourceNoticesLink(text: () -> String = { Notices.text }) {
    var open by rememberSaveable { mutableStateOf(false) }
    TextButton(
        onClick = { open = true },
        modifier = Modifier.settingRow("open-source-notices").testTag("openSourceNotices"),
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
    ) { Text("Open Source Notices") }
    if (open) NoticesDialog(text(), onClose = { open = false })
}

@Composable
private fun NoticesDialog(text: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(horizontal = 12.dp).testTag("noticesDialog"),
            shape = RectangleShape,
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Open Source Notices",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    text,
                    Modifier.weight(1f).fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant)
                        .verticalScroll(rememberScrollState()).padding(12.dp).testTag("noticesText"),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onClose, modifier = Modifier.testTag("noticesDone")) { Text("Done") }
                }
            }
        }
    }
}
