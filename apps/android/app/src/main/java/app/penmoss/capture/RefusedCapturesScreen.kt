package app.penmoss.capture

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
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
import app.penmoss.engine.api.CaptureRequest

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
                title = { Text("Captures not added") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
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
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(capture.text, maxLines = 6, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                    Text(capture.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = { onCopy(capture) }, Modifier.testTag("refusedCopy")) { Text("Copy") }
                        TextButton(onClick = { onRetry(capture) }, Modifier.testTag("refusedRetry")) { Text("Try Again") }
                        if (capture.missingPictures) {
                            TextButton(onClick = { onWithoutPictures(capture) }, Modifier.testTag("refusedWithoutPictures")) {
                                Text("Send Without Them")
                            }
                        }
                        TextButton(onClick = { discarding = capture.id }, Modifier.testTag("refusedDiscard")) { Text("Discard") }
                    }
                }
                HorizontalDivider()
            }
        }
    }
    captures.firstOrNull { it.id == discarding }?.let { capture ->
        AlertDialog(
            onDismissRequest = { discarding = null },
            title = { Text("Discard this capture?") },
            text = { Text("It is only on this phone, so its text is lost. Copy it first to keep it.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        discarding = null
                        onDiscard(capture)
                    },
                    Modifier.testTag("refusedDiscardConfirm"),
                ) { Text("Discard") }
            },
            dismissButton = { TextButton(onClick = { discarding = null }) { Text("Cancel") } },
        )
    }
}
