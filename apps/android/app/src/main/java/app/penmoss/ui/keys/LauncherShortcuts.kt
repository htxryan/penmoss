package app.penmoss.ui.keys

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import app.penmoss.R
import app.penmoss.capture.CaptureActivity
import app.penmoss.capture.ShareIntents
import app.penmoss.engine.notes.DeepLink
import app.penmoss.engine.notes.DeepLinks

/** What a launcher shortcut asks the app to show (T40 P9, PL3, A496). */
sealed interface LauncherAction {
    /** Kept across the activity's rebuild while it waits (A496). */
    val name: String

    data object NewNote : LauncherAction {
        override val name = "newNote"
    }

    data object Today : LauncherAction {
        override val name = "today"
    }

    data object Search : LauncherAction {
        override val name = "search"
    }

    /** This week's note: a git Journal notebook's screens open on it (T50 G7, A827). */
    data object ThisWeek : LauncherAction {
        override val name = "thisWeek"
    }

    /** Opens the note, as a `penmoss://note/<id>` link does (P7's [app.penmoss.ui.DeepLinkInbox]). */
    data class OpenNote(val id: String) : LauncherAction {
        override val name = "note"
    }

    companion object {
        /** The waiting action [name] stood for; never a note, which waits as a link does. */
        fun named(name: String?): LauncherAction? = listOf(NewNote, Today, Search, ThisWeek).firstOrNull { it.name == name }
    }
}

/**
 * Launcher app shortcuts (T40 P9, PL3, A496), Android's answer to the Mac's Dock menu: a long
 * press on Penmoss's icon offers Quick capture, New note, Today and Search, and the two notes
 * opened here last. Each can be pinned to the home screen. They are published from code (not a
 * static `shortcuts.xml`) so the debug build's own package is named, and the notes' are the
 * phone's own.
 *
 * Every app shortcut but Quick capture goes to [ALIAS], an activity alias of MainActivity that
 * is not exported: the launcher starts a shortcut as the app itself, while no other app can
 * reach the alias. [actionOf] reads an intent only when it came through it, so a link or intent
 * from another app never makes a note. Quick capture opens the capture sheet, as the tile does.
 */
object LauncherShortcuts {
    const val ALIAS = "app.penmoss.ui.LauncherShortcut"
    const val ACTION_NEW_NOTE = "app.penmoss.action.NEW_NOTE"
    const val ACTION_TODAY = "app.penmoss.action.TODAY"
    const val ACTION_SEARCH = "app.penmoss.action.SEARCH"
    const val ACTION_OPEN_NOTE = "app.penmoss.action.OPEN_NOTE"
    const val EXTRA_NOTE = "note"

    /** Notes opened here, at most this many, after the four fixed ones. */
    const val RECENT_NOTES = 2
    private const val NOTE_PREFIX = "note-"
    private const val SHORT_LABEL = 25

    /**
     * The action a launcher shortcut's intent asks for; null for any other intent, and for one
     * Recents replays after Back closed the app (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`), which
     * would otherwise make a second note (review S5). A note's id is checked as a deep link's
     * (a ULID, P7's `DeepLinks`).
     */
    fun actionOf(intent: Intent?): LauncherAction? {
        if (intent?.component?.className != ALIAS) return null
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
        return when (intent.action) {
            ACTION_NEW_NOTE -> LauncherAction.NewNote
            ACTION_TODAY -> LauncherAction.Today
            ACTION_SEARCH -> LauncherAction.Search
            ACTION_OPEN_NOTE -> noteId(intent.getStringExtra(EXTRA_NOTE))?.let(LauncherAction::OpenNote)
            else -> null
        }
    }

    private fun noteId(id: String?): String? =
        id?.let { (DeepLinks.parse("${DeepLinks.SCHEME}://note/$it") as? DeepLink.Note)?.id }

    private fun alias(context: Context, action: String) = Intent(action).setClassName(context, ALIAS)

    /** The four fixed shortcuts, in the order the launcher lists them. */
    fun fixed(context: Context): List<ShortcutInfoCompat> {
        fun shortcut(id: String, short: String, long: String, intent: Intent, rank: Int, icon: Int) =
            ShortcutInfoCompat.Builder(context, id).setShortLabel(short).setLongLabel(long)
                .setIcon(IconCompat.createWithResource(context, icon)).setIntent(intent).setRank(rank).build()
        val capture = Intent(context, CaptureActivity::class.java).setAction(ShareIntents.ACTION_CAPTURE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        return listOf(
            shortcut("capture", "Capture", "Quick Capture", capture, 0, R.drawable.ic_capture),
            shortcut("new-note", "New Note", "New Note", alias(context, ACTION_NEW_NOTE), 1, R.drawable.ic_shortcut_new_note),
            shortcut("today", "Today", "Today's Note", alias(context, ACTION_TODAY), 2, R.drawable.ic_shortcut_today),
            shortcut("search", "Search", "Search Notes", alias(context, ACTION_SEARCH), 3, R.drawable.ic_shortcut_search),
        )
    }

    /** The notes in the shortcuts now, newest first. */
    fun recentNotes(context: Context): List<Pair<String, String>> =
        ShortcutManagerCompat.getDynamicShortcuts(context)
            .filter { it.id.startsWith(NOTE_PREFIX) }
            .sortedBy { it.rank }
            .map { it.id.removePrefix(NOTE_PREFIX) to it.shortLabel.toString() }

    /** Publishes the fixed shortcuts and [notes] (id, title), newest first, at most [RECENT_NOTES]. */
    fun publish(context: Context, notes: List<Pair<String, String>> = recentNotes(context)) {
        val icon = IconCompat.createWithResource(context, R.drawable.ic_shortcut_note)
        val recent = notes.distinctBy { it.first }.take(RECENT_NOTES).mapIndexed { at, (id, title) ->
            val label = title.ifBlank { "Untitled" }
            ShortcutInfoCompat.Builder(context, NOTE_PREFIX + id)
                .setShortLabel(label.take(SHORT_LABEL))
                .setLongLabel(label.take(45))
                .setIcon(icon)
                .setIntent(alias(context, ACTION_OPEN_NOTE).putExtra(EXTRA_NOTE, id))
                .setRank(4 + at)
                .build()
        }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(context, fixed(context) + recent) }
    }

    /** A note was opened here: it leads the recent ones. */
    fun noteOpened(context: Context, id: String, title: String) {
        val now = recentNotes(context)
        if (now.firstOrNull() == (id to title.ifBlank { "Untitled" }.take(SHORT_LABEL))) return
        publish(context, listOf(id to title) + now.filter { it.first != id })
    }
}
