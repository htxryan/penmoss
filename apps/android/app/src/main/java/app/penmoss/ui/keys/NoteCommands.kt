package app.penmoss.ui.keys

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.editor.NoteEditorController
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor

/** What the open note's commands do (T40 P9): the note screen's own actions. */
data class NoteActions(
    val trash: () -> Unit,
    val move: () -> Unit,
    val history: () -> Unit,
    val saveVersion: () -> Unit,
    val tags: () -> Unit,
    val openPeriodic: (ToEditor.PeriodKind, String) -> Unit,
    /** Copy as Markdown and as rich text, and the Markdown source (T40 P8, ED9, ED17). */
    val copyMarkdown: () -> Unit = {},
    val copyRich: () -> Unit = {},
    val toggleSource: () -> Unit = {},
    /** The Info sheet with the backlinks (T40 P7, NT23), and the note's graph (LK8). */
    val info: () -> Unit = {},
    val localGraph: () -> Unit = {},
    /** The Comments sheet (T48). */
    val comments: () -> Unit = {},
    /** Pin to (or Unpin from) Quick Access (T51, A946); null where it is not offered (a git note). */
    val pinQuickAccess: (() -> Unit)? = null,
    /** Copy Agent Reference (T52 item 4); null until the note is held (a new note not made yet). */
    val copyAgentReference: (() -> Unit)? = null,
    /** Add Note Comment (T52 item 5): the Comments tab, with a thread on the note as a whole. */
    val addNoteComment: () -> Unit = {},
)

/**
 * The open note's commands (T40 P9, PL9, A494): Move to Trash, Move to folder…, Version history,
 * Save a version, Edit the title, Add a tag, Copy as Markdown and as rich text, the Markdown
 * source, Info (with the backlinks), the note's graph and, on a daily or weekly note, the
 * previous, next and week, each when the note can do it, as its menu offers it. While the note is shown, the page's
 * dispatcher gets the user's bindings and the commands the app runs now, and sends back the
 * keys it took for them; and the note leads the launcher's recent notes (PL3, A496).
 */
@Composable
fun NoteCommands(
    controller: NoteEditorController,
    /** The note is open and loaded (its menu's actions are enabled). */
    ready: Boolean,
    editable: Boolean,
    /** A real note's id and title for the launcher, or null on a transient periodic screen. */
    launcherNote: Pair<String, String>?,
    nav: FromEditor.PeriodicNavData?,
    actions: NoteActions,
) {
    NoteCommandSet(ready, editable, nav, focusTitle = { controller.focusTitle() }, actions)

    val commands = LocalAppCommands.current
    DisposableEffect(commands, controller) {
        commands.editorOpen = true
        controller.onCommand = { id -> commands.run(id) }
        onDispose {
            commands.editorOpen = false
            controller.onCommand = {}
        }
    }
    val raw by commands.raw.collectAsStateWithLifecycle()
    val revision by commands.revision.collectAsStateWithLifecycle()
    // The page dispatches with these; sent again whenever the bindings or the handlers change,
    // and whenever the note becomes ready or editable (a handler's `enabled` may then change).
    LaunchedEffect(controller, raw, revision, ready, editable, nav) {
        val app = commands.availableIds().filter { commands.catalogue.command(it)?.scope == "global" }
        controller.keys(raw, app)
    }

    // Once per note opened, with its title then: not again on every keystroke of a rename.
    val context = LocalContext.current
    val shown by rememberUpdatedState(launcherNote)
    LaunchedEffect(launcherNote?.first) {
        val (id, title) = shown ?: return@LaunchedEffect
        LauncherShortcuts.noteOpened(context.applicationContext, id, title)
    }
}

/** The note's commands as registered (split out so the screens test without a page). */
@Composable
internal fun NoteCommandSet(
    ready: Boolean,
    editable: Boolean,
    nav: FromEditor.PeriodicNavData?,
    focusTitle: () -> Unit,
    actions: NoteActions,
) {
    val isReady by rememberUpdatedState(ready)
    val canEdit by rememberUpdatedState(editable)
    val period by rememberUpdatedState(nav)
    RegisterCommand("note.delete", enabled = { isReady }) { actions.trash() }
    RegisterCommand("note.move", enabled = { isReady }) { actions.move() }
    RegisterCommand("note.history", enabled = { isReady }) { actions.history() }
    RegisterCommand("note.saveVersion", enabled = { isReady }) { actions.saveVersion() }
    RegisterCommand("note.addTag", enabled = { isReady }) { actions.tags() }
    RegisterCommand("note.focusTitle", enabled = { canEdit }) { focusTitle() }
    RegisterCommand("note.copyMarkdown", enabled = { isReady }) { actions.copyMarkdown() }
    RegisterCommand("note.copyRich", enabled = { isReady }) { actions.copyRich() }
    RegisterCommand("note.toggleSource", enabled = { isReady }) { actions.toggleSource() }
    RegisterCommand("note.backlinks", enabled = { isReady }) { actions.info() }
    RegisterCommand("note.localGraph", enabled = { isReady }) { actions.localGraph() }
    RegisterCommand("note.comments", enabled = { isReady }) { actions.comments() }
    RegisterCommand("note.pinQuickAccess", enabled = { isReady && actions.pinQuickAccess != null }) {
        actions.pinQuickAccess?.invoke()
    }
    RegisterCommand("note.addNoteComment", enabled = { canEdit }) { actions.addNoteComment() }
    RegisterCommand("note.copyAgentReference", enabled = { actions.copyAgentReference != null }) {
        actions.copyAgentReference?.invoke()
    }
    RegisterCommand("journal.previous", enabled = { period != null }) {
        period?.let { actions.openPeriodic(it.kind, it.prev.date) }
    }
    RegisterCommand("journal.next", enabled = { period != null }) {
        period?.let { actions.openPeriodic(it.kind, it.next.date) }
    }
    RegisterCommand("journal.week", enabled = { period?.week != null }) {
        period?.week?.let { actions.openPeriodic(ToEditor.PeriodKind.WEEKLY, it.date) }
    }
}

/**
 * Save a version now from a key (T40 P9, NT20), as Version history's Save version does: the open
 * editor's last edits are stored, the note is exchanged so the version has them, then saved.
 * Returns what to say. When the exchange did not go through, nothing is saved.
 */
suspend fun saveVersionNow(
    flush: suspend () -> Unit,
    exchange: suspend () -> Any?,
    save: suspend () -> Unit,
    failure: (Exception) -> String,
): String = try {
    flush()
    if (exchange() == null) {
        "The version was not saved: the note could not be exchanged. Check the connection and try again."
    } else {
        save()
        "Saved a version of the note as it is now."
    }
} catch (error: kotlinx.coroutines.CancellationException) {
    throw error
} catch (error: Exception) {
    failure(error)
}
