package app.penmoss.ui.note

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.TextButton

/**
 * The note screen's bar while the drawing editor is open over the note (PEN-189): the editor's
 * title ("New Excalidraw Diagram" or "Edit Excalidraw Diagram"), then Cancel and Done, the Mac's
 * icon-and-text buttons (A1386), Done the primary one. It stands in for the note's bar, as the
 * Mac's drawing editor has a bar of its own, and is counted as the Mac's `drawing` dialog is: done
 * when Done keeps the drawing, cancel otherwise.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DrawingBar(title: String, onCancel: () -> Unit, onDone: () -> Unit) {
    val tracked = rememberTrackedDialog("drawing")
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        actions = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(end = 8.dp)) {
                TextButton(onClick = trackedClick("drawing.cancel", onCancel), modifier = Modifier.testTag("drawingCancel")) {
                    Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Cancel")
                }
                Button(onClick = trackedClick("drawing.done", tracked.done(onDone)), modifier = Modifier.testTag("drawingDone")) {
                    Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Done")
                }
            }
        },
        modifier = Modifier.testTag("drawingBar"),
    )
}
