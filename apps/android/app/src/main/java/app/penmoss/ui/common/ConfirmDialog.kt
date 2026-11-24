package app.penmoss.ui.common

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick

/**
 * The app's confirm style (docs/ux-conventions.md, Settings): a question, what it does, one
 * answer and Cancel. Counted as the dialog [dialog] (`confirm` unless the catalogue names it
 * otherwise), its answer as [confirmEvent] and its Cancel as [cancelEvent]; the answer closes it
 * as `done`. A [destructive] answer (a delete, a discard, a forget, a reset) is in the error
 * colour, as everywhere. [recordOutsideDismiss] counts a tap outside or Back as [cancelEvent]
 * too, as Privacy's do; the rest close without a click.
 */
@Composable
fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    confirmEvent: String,
    cancelEvent: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    destructive: Boolean = false,
    cancelLabel: String = "Cancel",
    confirmTag: String? = null,
    cancelTag: String? = null,
    bodyTag: String? = null,
    dialog: String = "confirm",
    recordOutsideDismiss: Boolean = false,
) {
    val tracked = rememberTrackedDialog(dialog)
    AlertDialog(
        onDismissRequest = if (recordOutsideDismiss) trackedClick(cancelEvent, onDismiss) else onDismiss,
        title = { Text(title) },
        text = { Text(body, bodyTag?.let { Modifier.testTag(it) } ?: Modifier, style = MaterialTheme.roles.body) },
        confirmButton = {
            TextButton(onClick = trackedClick(confirmEvent, tracked.done(onConfirm)), modifier = confirmTag?.let { Modifier.testTag(it) } ?: Modifier) {
                Text(confirmLabel, color = if (destructive) MaterialTheme.colorScheme.error else Color.Unspecified)
            }
        },
        dismissButton = {
            TextButton(onClick = trackedClick(cancelEvent, onDismiss), modifier = cancelTag?.let { Modifier.testTag(it) } ?: Modifier) { Text(cancelLabel) }
        },
        modifier = modifier,
    )
}
