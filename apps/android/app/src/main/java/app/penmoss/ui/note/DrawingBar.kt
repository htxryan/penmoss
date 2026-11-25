package app.penmoss.ui.note

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.IconAndText
import app.penmoss.ui.common.TextButton

/**
 * The note screen's bar while the drawing editor is open over the note (PEN-189): the editor's
 * title ("New Excalidraw Diagram" or "Edit Excalidraw Diagram"), then Cancel and Done, the Mac's
 * icon-and-text buttons with its Lucide icons (A1386), Done the primary one. It stands in for the
 * note's bar, as the Mac's drawing editor has a bar of its own. Both buttons wait while Done is
 * [saving], as the Mac's do. The note screen counts it as the Mac's `drawing` dialog.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DrawingBar(title: String, saving: Boolean, onCancel: () -> Unit, onDone: () -> Unit) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        actions = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(end = 8.dp)) {
                TextButton(
                    onClick = trackedClick("drawing.cancel", onCancel),
                    enabled = !saving,
                    modifier = Modifier.testTag("drawingCancel"),
                ) { IconAndText("x", "Cancel") }
                Button(
                    onClick = trackedClick("drawing.done", onDone),
                    enabled = !saving,
                    modifier = Modifier.testTag("drawingDone"),
                ) { IconAndText("check", "Done") }
            }
        },
        modifier = Modifier.testTag("drawingBar"),
    )
}
