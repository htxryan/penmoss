package app.penmoss.ui

import app.penmoss.engine.bridge.ToEditor

/**
 * What Search's actions reach (T40 P6, FD6): the screens and the app's own handlers, as the
 * web's commands reach theirs (`CommandsRoot.tsx`).
 */
internal class ActionTargets(
    /** Opens a screen by its route. */
    val open: (String) -> Unit,
    /** Back to Home, closing what is open (the web's `app.home`, "Close the note"). */
    val home: () -> Unit,
    /** New note, asking which folder (Home's +, NT9). */
    val newNote: () -> Unit,
    /** New folder at the top level (NT2). */
    val newFolder: () -> Unit,
    /** The quick-capture sheet (T34), as the tile and widget open it. */
    val capture: () -> Unit,
    /** Today's or this week's note, made from the template offline too (JR1, JR2). */
    val periodic: (ToEditor.PeriodKind) -> Unit,
    /** Light if dark is shown, dark otherwise, as the web's `toggleDarkMode` (ST3). */
    val toggleDark: () -> Unit,
    /** Send feedback (T49, D41): the screen behind is captured, then the form opens. */
    val feedback: () -> Unit = {},
)

/** Runs the Search action [id] (a `{"search": true}` command of `commands-v1.json`); false when unknown. */
internal fun runSearchAction(id: String, to: ActionTargets): Boolean {
    when (id) {
        // Settings → Keyboard shortcuts lists the keys and changes them (T40 P9, ST8, FD8).
        "app.cheatsheet", "app.shortcuts" -> to.open(app.penmoss.ui.keys.CommandRoutes.SHORTCUTS)
        "app.settings" -> to.open(SettingsRoutes.HOME)
        "app.gitNotebooks" -> to.open(app.penmoss.ui.keys.CommandRoutes.GIT_NOTEBOOKS)
        "app.status" -> to.open(app.penmoss.ui.keys.CommandRoutes.ABOUT)
        "app.sendFeedback" -> to.feedback()
        "app.home" -> to.home()
        // Every note's graph, as Home's ⋮ → Graph opens it (T40 P7, LK7).
        "app.graph" -> to.open(graphRoute(null))
        "note.new" -> to.newNote()
        "app.capture" -> to.capture()
        "app.trash" -> to.open(TrashRoutes.TRASH)
        "journal.today" -> to.periodic(ToEditor.PeriodKind.DAILY)
        "journal.thisWeek" -> to.periodic(ToEditor.PeriodKind.WEEKLY)
        "journal.calendar" -> to.open("journal")
        "journal.settings" -> to.open(SettingsRoutes.DAILY)
        "folder.new" -> to.newFolder()
        "app.appearance", "theme.switch" -> to.open(SettingsRoutes.APPEARANCE)
        // Home's shortcuts, as the web's sidebar's (T42 on Android, ST12, A650).
        "app.display" -> to.open(SettingsRoutes.DISPLAY)
        // The line symbols (T44, ST13, A747).
        "app.symbols" -> to.open(SettingsRoutes.SYMBOLS)
        "theme.toggleDark" -> to.toggleDark()
        else -> return false
    }
    return true
}
