package app.penmoss.ui

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import app.penmoss.editor.PeriodicNoteRequest
import app.penmoss.engine.bridge.ToEditor

/** A note's screen (T32, T38), and Today, a calendar day or a week's note (T40 P5). */
internal fun NavGraphBuilder.noteRoutes(root: RootUi) {
    val graph = root.graph
    val nav = root.nav
    composable(NOTE_ROUTE, arguments = noteArguments) { entry ->
        val id = entry.arguments?.getString("id") ?: return@composable
        // New note (T38): the editor makes it with this id and it is filed in the folder chosen.
        NoteRoute(
            graph,
            id,
            onBack = { nav.leave(entry) },
            onOpenNote = root::openNote,
            onOpenNoteAt = root::openNoteAt,
            onLocalGraph = { nav.open(graphRoute(id)) },
            heading = entry.arguments?.getString("heading"),
            onOpenTag = root::openTag,
            create = newNoteRequest(entry),
            onMade = entry::markNoteMade,
            onSyncStorage = { nav.open(SettingsRoutes.SYNC) },
            // Leaves the note (its last edits are stored as it goes), then moves it to Trash.
            onTrash = {
                nav.leave(entry)
                root.trashNote(id)
            },
            focusTitle = entry.arguments?.getBoolean("focusTitle") == true,
            // The breadcrumb's folder (T40 P4, NT11).
            onOpenFolder = root::openFolderFromNote,
        )
    }
    // Today, a calendar day or a week's note (T40 P5, JR1, JR2): the editor page makes
    // it with the synced time zone and template, offline too; a note held already is
    // just opened. The screen is transient: once made, the note itself opens.
    composable(PERIODIC_ROUTE, arguments = periodicArguments) { entry ->
        val kind = ToEditor.PeriodKind.of(entry.arguments?.getString("kind")) ?: ToEditor.PeriodKind.DAILY
        val day = entry.arguments?.getString("day")
        NoteRoute(
            graph,
            periodicScreenId(kind, day),
            onBack = { nav.leave(entry) },
            onOpenNote = root::openNote,
            onOpenTag = root::openTag,
            periodic = PeriodicNoteRequest(kind, day),
            onPeriodicMade = { id ->
                if (nav.replaceWithNote(entry, id)) graph.sync.requestSync()
            },
            onOpenPeriodic = { next, date -> root.openPeriodic(next, date) },
            onSyncStorage = { nav.open(SettingsRoutes.SYNC) },
            onOpenFolder = root::openFolderFromNote,
        )
    }
}
