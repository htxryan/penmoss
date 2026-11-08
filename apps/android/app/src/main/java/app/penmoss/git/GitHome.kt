package app.penmoss.git

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import app.penmoss.ui.square.Button
import app.penmoss.ui.square.FilledTonalButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.ui.DotState
import app.penmoss.ui.SectionTitle
import app.penmoss.ui.SyncDot
import app.penmoss.ui.SyncStateDot
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import kotlinx.coroutines.launch

/**
 * The app's home (T50 G7, A828; T59, A1040): the git notebooks on this phone, each opening its own
 * screens, with Add. With none yet, the first run asks to add or create one; there is no sign-in
 * and no personal notes.
 */
@Composable
fun NotebooksHome(graph: AppGraph, onBack: () -> Unit) {
    val context = LocalContext.current
    GitNotebooksRoute(graph.git, onOpen = { GitNotebookActivity.open(context, it) }, onBack = onBack, home = true)
}

/**
 * A git notebook's Sync (T50 G7, A880): its repository's sync as the page says it, with the host's
 * own words (A824), what waits to be pushed, Sync now, and the way to Settings → Git notebooks for
 * what only the person can do (a token, Delete for good again, Keep note).
 */
@Composable
fun GitSyncRoute(graph: AppGraph, passText: String, onGitNotebooks: () -> Unit, onBack: () -> Unit, onAgentActivity: () -> Unit = {}) {
    val source = graph.source as? GraphSource.Git ?: return
    val hub = graph.git
    val statuses by hub.statuses.collectAsStateWithLifecycle()
    val views by hub.list.collectAsStateWithLifecycle()
    val view = views.firstOrNull { it.localId == source.localId }
    val status = statuses[source.localId]
    val recoveries by hub.recoveries.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val saveUnrecovered = rememberSaveUnrecovered(hub) { message = it }
    val withheld by hub.withheld.collectAsStateWithLifecycle()
    val saveWithheld = rememberSaveUnrecovered(hub, withheld = true) { message = it }
    fun act(block: suspend () -> Unit) {
        scope.launch {
            message = try {
                block()
                null
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Exception) {
                error.message ?: "That did not work."
            }
        }
    }
    SectionScreen("Sync", onBack, notice = message) {
        GroupTitle(source.name)
        Help(view?.let { "${it.repository}${if (it.branch != "main") " · ${it.branch}" else ""}${if (it.dir.isNotEmpty()) " · ${it.dir}/" else ""}" } ?: "")
        Text(
            gitStatusLine(status, view?.host ?: "the git host"),
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("gitSyncStatus").semantics { liveRegion = LiveRegionMode.Polite },
            color = if (status?.phase == "stopped") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        status?.hostMessage?.let { Help("${view?.host ?: "The host"} said: $it") }
        recoveries[source.localId]?.let { notice ->
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                RecoveryNotice(notice, onSave = { saveUnrecovered(source.localId) }) { hub.dismissRecovery(source.localId) }
            }
        }
        withheld[source.localId]?.let { copies ->
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                WithheldNotice(
                    copies,
                    onSave = { saveWithheld(source.localId) },
                    onDelete = { act { hub.dropWithheld(source.localId, it) } },
                    onKeep = { act { hub.keepWithheld(source.localId, it) } },
                )
            }
        }
        if (status?.handEdits?.isNotEmpty() == true) Help(handEditsText(status.handEdits))
        if (status?.skipped?.isNotEmpty() == true) {
            Help("Left as they are, unreadable here: ${status.skipped.keys.take(5).joinToString(", ")}${if (status.skipped.size > 5) "…" else ""}")
        }
        Help("Notes on this phone: ${passText.ifEmpty { "not read yet" }}")
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    busy = true
                    scope.launch {
                        message = runCatching { hub.syncNow(source.localId) }.exceptionOrNull()?.message
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.testTag("gitSyncNow"),
            ) { Text(if (busy) "Syncing…" else "Sync Now") }
            FilledTonalButton(onClick = onGitNotebooks, Modifier.testTag("gitSyncSettings")) { Text("Git Notebooks") }
        }
        // What its agents changed in folders, note places and settings, with Undo (#172, A920).
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onAgentActivity, Modifier.testTag("gitAgentActivity")) { Text("Agent Activity") }
        }
        Help("What agents (a CLI or MCP clone added with --agent) changed in this notebook's folders, note places and settings, read from its branch, each with Undo. Their edits to notes are in each note's History.")
        Column(Modifier.padding(horizontal = 16.dp)) {
            Text(
                "Pulls when you open the notebook and every ${view?.pullEveryMin ?: app.penmoss.engine.git.GitCadence.PULL_EVERY_MIN} min while it is open, pushes ${view?.pushDelayS ?: app.penmoss.engine.git.GitCadence.PUSH_DELAY_S} s after edits settle, " +
                    "and syncs about every 15 minutes in the background.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Storage on this phone and pictures from the web (T40 P8, ED12, ED13): here since the
        // account's Sync and storage went with the server (T59).
        app.penmoss.ui.StorageRoute(graph)
    }
}

/**
 * Rendered files someone edited by hand in the repository: the sync overwrote them from the
 * notes, which are the source, as the Mac's Settings and the CLI say. They said "read back", which
 * told Ryan his edits were kept when they were replaced (git's history still has them) (T39 pass 3, A893).
 */
internal fun handEditsText(paths: List<String>): String {
    val shown = paths.take(5).joinToString(", ") + if (paths.size > 5) "…" else ""
    return "Edited by hand: Penmoss wrote ${if (paths.size == 1) "it" else "these"} again from the notes (edit them in Penmoss): $shown"
}
