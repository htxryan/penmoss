package app.penmoss.git

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedButton
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.size
import app.penmoss.ui.common.roles
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.git.OwnerWords
import app.penmoss.ui.settings.Help

/* What a notebook says about its notes: what Android clearing the store brought back (A886), the copies kept on this phone, and the deletions for good waiting on its branch; split from GitNotebooksScreen.kt (PEN-186). */

/**
 * What came of Android clearing the store (A886): notes brought back, and copies that could not
 * be, with Save their text; said plainly, until dismissed.
 */
@Composable
fun RecoveryNotice(notice: GitRecoveryNotice, onSave: () -> Unit = {}, onDismiss: () -> Unit) {
    if (!notice.shown) return
    Card(
        Modifier.fillMaxWidth().testTag("gitRecovered").semantics { liveRegion = LiveRegionMode.Polite },
        colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (notice.titles.isEmpty()) "Notes Not Brought Back" else "Notes Brought Back",
                style = MaterialTheme.roles.groupHead,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(notice.words(), style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onErrorContainer)
            Row {
                if (notice.unrecovered.isNotEmpty()) {
                    TextButton(onClick = trackedClick("settings.git-notebooks.recovered.save", onSave), Modifier.testTag("gitRecoveredSave")) { Text("Save Their Text") }
                }
                TextButton(onClick = trackedClick("settings.git-notebooks.recovered.dismiss", onDismiss), Modifier.testTag("gitRecoveredDismiss")) { Text("Got It") }
            }
        }
    }
}

/**
 * Copies withheld from the push (A886): brought back after Android cleared the store, their
 * original then deleted for good on another device. Said plainly while any is kept, each with
 * Delete for good and Keep and sync (both behind the phone's own check), and Save their text.
 */
@Composable
fun WithheldNotice(copies: List<WithheldView>, onSave: () -> Unit, onDelete: (String) -> Unit, onKeep: (String) -> Unit) {
    if (copies.isEmpty()) return
    Card(
        Modifier.fillMaxWidth().testTag("gitWithheld").semantics { liveRegion = LiveRegionMode.Polite },
        colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (copies.size == 1) {
                    "A recovered copy of a note deleted for good on another device was kept on this device only."
                } else {
                    "${copies.size} recovered copies of notes deleted for good on another device were kept on this device only."
                },
                Modifier.testTag("gitWithheldWords"),
                style = MaterialTheme.roles.groupHead,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                "Nothing of ${if (copies.size == 1) "it" else "them"} was pushed. Keep and Sync pushes a copy as a new note; Delete for Good removes it from this phone. The phone asks for your fingerprint, face or screen lock first.",
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            for (copy in copies) {
                Text(
                    OwnerWords.title(copy.title) ?: "An untitled note",
                    Modifier.testTag("gitWithheldTitle-${copy.noteId}"),
                    style = MaterialTheme.roles.body,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                Row {
                    TextButton(onClick = trackedClick("settings.git-notebooks.withheld.keep") { onKeep(copy.noteId) }, Modifier.testTag("gitWithheldKeep-${copy.noteId}")) { Text("Keep and Sync") }
                    TextButton(onClick = trackedClick("settings.git-notebooks.withheld.delete") { onDelete(copy.noteId) }, Modifier.testTag("gitWithheldDelete-${copy.noteId}")) { Text("Delete for Good") }
                }
            }
            TextButton(onClick = trackedClick("settings.git-notebooks.withheld.save", onSave), Modifier.testTag("gitWithheldSave")) { Text("Save Their Text") }
        }
    }
}

/** Deletes for good waiting (A855): confirmed again only where this phone confirmed them once; Keep note for the rest. */
@Composable
internal fun Purges(row: GitRow, actions: GitNotebooksActions) {
    val id = row.view.localId
    val purges = row.purges
    LaunchedEffect(id, purges == null) { if (purges == null) actions.onShowPurges(id) }
    Text("Delete for Good, Waiting", style = MaterialTheme.roles.groupHead)
    if (purges == null) {
        Text("Reading the notes from the branch…", style = MaterialTheme.roles.help)
        return
    }
    Kept(row, actions)
    if (purges.isEmpty()) {
        Text("Nothing waits: the next sync goes on.", style = MaterialTheme.roles.help)
        return
    }
    Help(
        "A sync stopped because it would delete these for good without a confirmation from the last 10 minutes. " +
            "Each is named as the branch has it. Keep note puts it back where it was and deletes nothing; " +
            "Delete for Good asks for your fingerprint, face or screen lock first.",
        Modifier.padding(0.dp),
    )
    for (purge in purges) {
        ListItem(
            // Named from the branch, cleaned and isolated as the owner check names it (OwnerWords).
            headlineContent = { Text(OwnerWords.title(purge.title) ?: "An untitled note", Modifier.testTag("gitPurgeTitle-${purge.id}")) },
            supportingContent = { Text(if (purge.confirmedBefore) "You confirmed this on this phone; it ran out" else "Never confirmed on this phone") },
            trailingContent = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.keep-note") { actions.onKeep(id, purge.id) }, Modifier.testTag("gitKeep-${purge.id}")) { Text("Keep Note") }
                    // Never confirmed here: Delete for good, behind the phone's own check, as on the Mac (A913).
                    if (!purge.confirmedBefore) {
                        TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.purge-note") { actions.onConfirmPurge(id, purge.id) }, Modifier.testTag("gitPurgeNote-${purge.id}")) { Text("Delete for Good") }
                    }
                }
            },
            modifier = Modifier.testTag("gitPurge-${purge.id}"),
        )
    }
    val again = purges.filter { it.confirmedBefore }.map { it.id }
    if (again.isNotEmpty()) {
        OutlinedButton(onClick = trackedClick("settings.git-notebooks.reconfirm.confirm") { actions.onConfirmPurges(id, again) }, Modifier.testTag("gitConfirmPurges-$id")) {
            // The button the refusal names ("Confirm Delete for good again in Settings → Git notebooks"), as on the Mac (A894).
            Text(if (again.size == 1) "Confirm Delete for Good Again" else "Confirm Delete for Good Again: ${again.size} notes")
        }
    }
}

/** Notes kept with Keep note while Settings is open (A913): each says so, with Undo. */
@Composable
internal fun Kept(row: GitRow, actions: GitNotebooksActions) {
    for (note in row.kept) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Kept ${OwnerWords.title(note.title) ?: "an untitled note"}.",
                Modifier.weight(1f).testTag("gitKept-${note.id}"),
                style = MaterialTheme.roles.body,
            )
            TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.undo-keep") { actions.onUndoKeep(row.view.localId, note.id) }, Modifier.testTag("gitKeepUndo-${note.id}")) { Text("Undo") }
        }
    }
}
