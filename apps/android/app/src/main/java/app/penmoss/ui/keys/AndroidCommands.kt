package app.penmoss.ui.keys

/**
 * Where each of the web's commands runs on Android (T40 P9, PL9, A497): the parity guard for the
 * keyboard. `AndroidCommandsTest` fails when `contract/shortcuts-v1.json` has a command with no
 * entry here, so a command added on the web is given its Android place (or a reason) before it
 * ships. [Native] commands are registered by the screens ([RootCommands], [NoteCommands]) and run
 * from a key, the page or Android's shortcut helper; [Page] commands are the editor page's own
 * (it dispatches their keys in the note); [Later] arrive with another slice, which registers a
 * handler; [NotHere] do not apply to a phone, with the reason.
 */
sealed interface Coverage {
    /** Run by the app; [where] says which screen registers it. */
    data class Native(val where: String) : Coverage

    /** The editor page runs it, with the user's keys (A493). */
    data object Page : Coverage

    /** Arrives with [slice]: its keys are listed and kept, and its handler comes with it. */
    data class Later(val slice: String) : Coverage

    /** Not on a phone, for [reason]. */
    data class NotHere(val reason: String) : Coverage
}

object AndroidCommands {
    private const val ANYWHERE = "every screen"

    private const val NOTE = "a note"
    private const val PERIODIC = "a daily or weekly note"
    private const val FOLDERS = "Home or a folder"
    private const val GIT_CARD = "The Mac app's git notebook commands (#170 F5): on the phone each is on the notebook's card in Settings → Git notebooks, where it keeps its BiometricPrompt."

    private val APP: Map<String, Coverage> = mapOf(
        // Search is where actions are found on the phone (FD6, adapted): P6 adds them to it.
        "app.palette" to Coverage.Native(ANYWHERE),
        "app.quickOpen" to Coverage.Native(ANYWHERE),
        "app.search" to Coverage.Native(ANYWHERE),
        "app.recent" to Coverage.Native(ANYWHERE),
        // Ctrl+/ opens the list in Settings; Meta+/ is Android's own helper (FD8, A495).
        "app.cheatsheet" to Coverage.Native(ANYWHERE),
        "app.settings" to Coverage.Native(ANYWHERE),
        "app.shortcuts" to Coverage.Native(ANYWHERE),
        // T50 G7 (D43, A856): Settings → Git notebooks, as on the Mac (#155).
        "app.gitNotebooks" to Coverage.Native(ANYWHERE),
        "app.status" to Coverage.Native(ANYWHERE),
        // T64 (A1112): the Mac app updates itself; a phone updates from where it was installed.
        "app.checkForUpdates" to Coverage.NotHere("The Mac app updates itself from GitHub Releases; the phone updates from where it was installed."),
        // In-app feedback (T49, D41): the screen behind is captured, then the form opens.
        "app.sendFeedback" to Coverage.Native(ANYWHERE),
        // T42 (A578): the web's Settings → Sync is the phone's Sync and storage (AC8, AC12).
        // Settings → Display: Home's shortcuts, synced with the sidebar's (ST12, A650).
        "app.display" to Coverage.Native(ANYWHERE),
        // Settings → Symbols: the line symbols, synced with the web's (T44, ST13, A747).
        "app.symbols" to Coverage.Native(ANYWHERE),
        "app.home" to Coverage.Native(ANYWHERE),
        "app.toggleSidebar" to Coverage.NotHere("A phone has no sidebar: Home and its screens are the rail's places (PL17)."),
        "app.graph" to Coverage.Native(ANYWHERE),
        "note.new" to Coverage.Native(FOLDERS),
        "app.capture" to Coverage.Native(ANYWHERE),
        "note.toggleSource" to Coverage.Native(NOTE),
        "note.delete" to Coverage.Native(NOTE),
        "note.move" to Coverage.Native(NOTE),
        "note.history" to Coverage.Native(NOTE),
        "note.saveVersion" to Coverage.Native(NOTE),
        "note.backlinks" to Coverage.Native(NOTE),
        "note.localGraph" to Coverage.Native(NOTE),
        "note.togglePanel" to Coverage.NotHere("The phone's note bar opens the panel on a tab: Info or Comments (T51, A936)"),
        // T51 (A946): the note ⋮ menu's Pin to Quick Access; the pins show on Home.
        "note.pinQuickAccess" to Coverage.Native(NOTE),
        // T48: the note's ⋮ menu's Comments, the Comments sheet; editor.comment is the page's (Comment).
        "note.comments" to Coverage.Native(NOTE),
        // T52 item 5: the Comments tab's Add Note Comment, a thread on the note as a whole.
        "note.addNoteComment" to Coverage.Native(NOTE),
        // T52 item 4: the note's ⋮ menu, Home's selection bar and a search result's sheet.
        "note.copyAgentReference" to Coverage.Native(NOTE),
        "app.trash" to Coverage.Native(ANYWHERE),
        // T45 (D37, A710): note windows are the Mac app's and the web's; a phone has one screen.
        "note.openInNewWindow" to Coverage.NotHere("A phone shows one screen at a time (PL7): Android's split screen and Recents already put Penmoss beside another app, and a note opened from a link opens on its own screen with Back (T45, D37)."),
        "window.back" to Coverage.NotHere("A note window's (T45): the phone's own Back goes back from a note to the one before it."),
        "window.forward" to Coverage.NotHere("A note window's (T45): a phone's screens have no Forward; Switch to a recent note (Ctrl+E) returns to a note left behind."),
        // T46 (D38, A720): pinning a window above other apps is the Mac app's.
        "window.keepOnTop" to Coverage.NotHere("The Mac app's (T46, D38): a phone shows one app at a time, full screen, and Android's split screen already keeps a note beside another app (PL20)."),
        "note.focusTitle" to Coverage.Native(NOTE),
        "note.copyMarkdown" to Coverage.Native(NOTE),
        "note.copyRich" to Coverage.Native(NOTE),
        "journal.today" to Coverage.Native(ANYWHERE),
        "journal.thisWeek" to Coverage.Native(ANYWHERE),
        "journal.previous" to Coverage.Native(PERIODIC),
        "journal.next" to Coverage.Native(PERIODIC),
        "journal.week" to Coverage.Native(PERIODIC),
        "journal.calendar" to Coverage.Native(ANYWHERE),
        "journal.settings" to Coverage.Native(ANYWHERE),
        "note.addTag" to Coverage.Native(NOTE),
        "tags.clearFilter" to Coverage.Native("a tag's notes"),
        "folder.new" to Coverage.Native(FOLDERS),
        // T43 (A750, A752): Home's ⋮ New notebook, and Settings → Notebooks.
        "folder.topLevel" to Coverage.NotHere("New note on the phone files in the folder shown, or asks for one (T38): there is no default folder to set."),
        "folder.sortManual" to Coverage.Native(FOLDERS),
        "folder.sortAlpha" to Coverage.Native(FOLDERS),
        "folder.sortModified" to Coverage.Native(FOLDERS),
        // A folder row's own keys, in Reorder mode (NT7, A445).
        "folder.moveUp" to Coverage.Native("a row in Reorder mode"),
        "folder.moveDown" to Coverage.Native("a row in Reorder mode"),
        "folder.rename" to Coverage.NotHere("A folder is renamed and deleted from its sheet (a long press, or TalkBack's actions): the phone's lists have no focused-row keys."),
        "folder.delete" to Coverage.NotHere("A folder is renamed and deleted from its sheet (a long press, or TalkBack's actions): the phone's lists have no focused-row keys."),
        "git.syncNow" to Coverage.NotHere(GIT_CARD),
        "git.signCommits" to Coverage.NotHere(GIT_CARD),
        "git.pushAfter" to Coverage.NotHere(GIT_CARD),
        "git.pullEvery" to Coverage.NotHere(GIT_CARD),
        "git.useToken" to Coverage.NotHere(GIT_CARD),
        "git.forgetToken" to Coverage.NotHere(GIT_CARD),
        "git.identity" to Coverage.NotHere(GIT_CARD),
        "git.reconfirmPurges" to Coverage.NotHere(GIT_CARD),
        "git.remove" to Coverage.NotHere(GIT_CARD),
        "app.appearance" to Coverage.Native(ANYWHERE),
        "theme.switch" to Coverage.Native(ANYWHERE),
        "theme.toggleDark" to Coverage.Native(ANYWHERE),
        "note.fullWidth" to Coverage.Native(ANYWHERE),
    )

    /** Where [id] runs on Android, or null when it has no entry (the coverage test fails). */
    fun coverage(id: String, scope: String): Coverage? = APP[id] ?: if (scope == "editor") Coverage.Page else null

    /** The app's commands that are not the page's, by id. */
    val app: Map<String, Coverage> get() = APP

    /** Whether the phone runs [id] now or later: listed in Settings → Keyboard shortcuts. */
    fun listed(id: String, scope: String): Boolean = coverage(id, scope).let { it != null && it !is Coverage.NotHere }
}
