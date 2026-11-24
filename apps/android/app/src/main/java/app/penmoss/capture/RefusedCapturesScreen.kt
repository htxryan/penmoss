package app.penmoss.capture

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.ui.common.BackButton
import app.penmoss.ui.common.ConfirmDialog
import app.penmoss.ui.common.roles

/**
 * Captures that cannot go as they are (T34 review S2, A345): each one's text and why, to
 * copy, try again, send without the pictures that would not upload, or discard. Nothing
 * here is deleted unless the person taps Discard.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefusedCapturesScreen(
    captures: List<Captures.Refused>,
    dateOf: (Long) -> String,
    onBack: () -> Unit,
    onCopy: (Captures.Refused) -> Unit,
    onRetry: (Captures.Refused) -> Unit,
    onWithoutPictures: (Captures.Refused) -> Unit,
    onDiscard: (Captures.Refused) -> Unit,
) {
    // Discarding deletes the only copy, so it asks first (T39, A386).
    var discarding by rememberSaveable { mutableStateOf<String?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Captures Not Added") },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        if (captures.isEmpty()) {
            Text("Nothing waits here.", Modifier.padding(padding).padding(16.dp))
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(captures, key = { it.id }) { capture ->
                Column(Modifier.fillMaxWidth().padding(16.dp).testTag("refusedCapture"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "${dateOf(capture.capturedAt)} · ${if (capture.destination == CaptureRequest.INBOX) "New note in Inbox" else "Today’s note"}",
                        style = MaterialTheme.roles.meta,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(capture.text, maxLines = 6, overflow = TextOverflow.Ellipsis, style = MaterialTheme.roles.body)
                    Text(capture.reason, style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.error)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = trackedClick("capture.refused.copy") { onCopy(capture) }, Modifier.testTag("refusedCopy")) { Text("Copy") }
                        TextButton(onClick = trackedClick("capture.refused.retry") { onRetry(capture) }, Modifier.testTag("refusedRetry")) { Text("Try Again") }
                        if (capture.missingPictures) {
                            TextButton(onClick = trackedClick("capture.refused.without-pictures") { onWithoutPictures(capture) }, Modifier.testTag("refusedWithoutPictures")) {
                                Text("Send Without Them")
                            }
                        }
                        TextButton(onClick = trackedClick("capture.refused.discard") { discarding = capture.id }, Modifier.testTag("refusedDiscard")) { Text("Discard") }
                    }
                }
                HorizontalDivider()
            }
        }
    }
    captures.firstOrNull { it.id == discarding }?.let { capture ->
        ConfirmDialog(
            title = "Discard This Capture?",
            body = "It is only on this phone, so its text is lost. Copy it first to keep it.",
            confirmLabel = "Discard",
            confirmEvent = "capture.refused.discard.confirm",
            cancelEvent = "capture.refused.discard.cancel",
            onConfirm = {
                discarding = null
                onDiscard(capture)
            },
            onDismiss = { discarding = null },
            destructive = true,
            confirmTag = "refusedDiscardConfirm",
        )
    }
}
