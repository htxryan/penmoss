package app.penmoss.ui.keys

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.capture.CaptureActivity
import app.penmoss.capture.ShareIntents
import app.penmoss.ui.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Launcher app shortcuts (T40 P9, PL3, A496): what a long press on the icon offers, and what each opens. */
@RunWith(AndroidJUnit4::class)
class LauncherShortcutsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager get() = context.getSystemService(ShortcutManager::class.java)

    @Before
    fun clear() {
        manager.removeAllDynamicShortcuts()
    }

    private fun shown() = manager.dynamicShortcuts.sortedBy { it.rank }.map { it.id to it.shortLabel.toString() }

    @Test
    fun offersCaptureNewNoteTodayAndSearchThenTheNotesOpenedLast() {
        LauncherShortcuts.publish(context)
        assertEquals(
            listOf("capture" to "Capture", "new-note" to "New Note", "today" to "Today", "search" to "Search"),
            shown(),
        )
        LauncherShortcuts.noteOpened(context, "n1", "Groceries")
        LauncherShortcuts.noteOpened(context, "n2", "")
        LauncherShortcuts.noteOpened(context, "n3", "A note with a title far longer than a launcher shows")
        LauncherShortcuts.noteOpened(context, "n2", "Plans")
        assertEquals(listOf("n2" to "Plans", "n3" to "A note with a title far l"), LauncherShortcuts.recentNotes(context))
        assertEquals(6, shown().size)
    }

    private val id = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"

    @Test
    fun eachShortcutOpensItsPlace() {
        LauncherShortcuts.publish(context, listOf(id to "Groceries"))
        val intents = manager.dynamicShortcuts.associate { it.id to it.intent }
        val capture = intents.getValue("capture")!!
        assertEquals(CaptureActivity::class.java.name, capture.component?.className)
        assertEquals(ShareIntents.ACTION_CAPTURE, capture.action)
        assertEquals(LauncherAction.NewNote, LauncherShortcuts.actionOf(intents["new-note"]))
        assertEquals(LauncherAction.Today, LauncherShortcuts.actionOf(intents["today"]))
        assertEquals(LauncherAction.Search, LauncherShortcuts.actionOf(intents["search"]))
        assertEquals(LauncherAction.OpenNote(id), LauncherShortcuts.actionOf(intents["note-$id"]))
        // The alias is MainActivity's, and not exported: only the launcher (as the app) reaches it.
        val alias = context.packageManager.getActivityInfo(android.content.ComponentName(context, LauncherShortcuts.ALIAS), 0)
        assertEquals(MainActivity::class.java.name, alias.targetActivity)
        assertEquals(false, alias.exported)
    }

    @Test
    fun anIntentFromElsewhereIsNotAShortcut() {
        // The same action straight to MainActivity (another app, or a link) is ignored.
        val direct = Intent(LauncherShortcuts.ACTION_NEW_NOTE).setClass(context, MainActivity::class.java)
        assertNull(LauncherShortcuts.actionOf(direct))
        assertNull(LauncherShortcuts.actionOf(Intent(LauncherShortcuts.ACTION_TODAY)))
        assertNull(LauncherShortcuts.actionOf(null))
        // A note id that is not one: a note's is a ULID, as a deep link's (P7's DeepLinks).
        for (bad in listOf("../../x", "n1", "01JD2Z7Q8R4T6Y8W0E2R4T6YB1/x")) {
            val intent = Intent(LauncherShortcuts.ACTION_OPEN_NOTE).setClassName(context, LauncherShortcuts.ALIAS)
                .putExtra(LauncherShortcuts.EXTRA_NOTE, bad)
            assertNull(bad, LauncherShortcuts.actionOf(intent))
        }
        val none = Intent("android.intent.action.VIEW").setClassName(context, LauncherShortcuts.ALIAS)
        assertNull(LauncherShortcuts.actionOf(none))
    }

    @Test
    fun aShortcutRecentsReplaysIsNotActedOnAgain() {
        // Back closed the app after New note; Recents starts it again with the same intent.
        val replayed = Intent(LauncherShortcuts.ACTION_NEW_NOTE).setClassName(context, LauncherShortcuts.ALIAS)
            .addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertNull(LauncherShortcuts.actionOf(replayed))
    }

    @Test
    fun aWaitingActionIsKeptByNameButANoteIsNot() {
        for (action in listOf(LauncherAction.NewNote, LauncherAction.Today, LauncherAction.Search)) {
            assertEquals(action, LauncherAction.named(action.name))
        }
        assertNull(LauncherAction.named(LauncherAction.OpenNote(id).name))
        assertNull(LauncherAction.named(null))
    }
}
