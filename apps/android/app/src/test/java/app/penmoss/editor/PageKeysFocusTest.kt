package app.penmoss.editor

import android.view.KeyEvent
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.keys.AppCommands
import app.penmoss.ui.keys.CommandHandler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Which focused view's keys the native dispatcher leaves to a page (T40 P9 review S1, A555):
 * only the note's editor page dispatches its own; the graph's and the theme preview's run no
 * key handling, so with either focused the app's shortcuts still run.
 */
@RunWith(AndroidJUnit4::class)
class PageKeysFocusTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun onlyTheNotesEditorPageTakesTheKeysWhileFocused() {
        // As EditorWebView.create makes them: the note's page marked, the graph's and preview's not.
        val note = SelectionWebView(context).apply { dispatchesKeys = true }
        val graph = SelectionWebView(context)
        assertTrue(EditorWebView.handsKeysToPage(note))
        assertFalse(EditorWebView.handsKeysToPage(graph))
        assertFalse(EditorWebView.handsKeysToPage(WebView(context)))
        assertFalse(EditorWebView.handsKeysToPage(null))
    }

    @Test
    fun ctrlShiftFOpensSearchAfterTheGraphWasTapped() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        commands.register("app.search", CommandHandler(run = { ran += "search" }))
        val graph = SelectionWebView(context)
        val ctrlShiftF = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
        assertTrue(commands.handle(ctrlShiftF, inEditor = EditorWebView.handsKeysToPage(graph)))
        assertEquals(listOf("search"), ran)
    }
}
