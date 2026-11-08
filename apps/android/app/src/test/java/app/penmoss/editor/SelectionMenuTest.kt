package app.penmoss.editor

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.PopupMenu
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.bridge.ClipFormat
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.ParityFromEditor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The editor's selection menu and clipboard (T40 P8, ED9, ED11, ED18) on Robolectric: the
 * WebView's own menu is played by a callback that fills the menu with Chromium's ids. Chromium's
 * Cut, Copy and Select all are its own resources (`R.id.select_action_menu_copy`), not the
 * framework's; Paste and Paste as plain text are the framework's (review B1). Whether the real
 * WebView's menu shows the items is a Pixel check (docs/android.md).
 */
@RunWith(AndroidJUnit4::class)
class SelectionMenuTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private class Hooks(override var editable: Boolean = true) : SelectionHooks {
        val copies = mutableListOf<CopyFormat>()
        var pastes = 0
        var finds = 0

        /** What reached the note, in order: the menu showing, then each action. */
        val events = mutableListOf<String>()

        override fun copyAs(format: CopyFormat) {
            copies += format
            events += "copy $format"
        }

        override fun pastePlain() {
            pastes++
            events += "paste"
        }

        override fun menuShown() {
            events += "shown"
        }

        override fun find() {
            finds++
        }
    }

    /**
     * The WebView's callback: Cut, Copy, Paste, Paste as plain text, Share, Select all, filled
     * again on prepare, with Chromium's ids (`copyTitle` as a localised system would name it).
     */
    private class WebViewMenu(private val copyTitle: String = "Copy", private val caret: Boolean = false) : ActionMode.Callback {
        val clicked = mutableListOf<Int>()
        var destroyed = false

        private fun fill(menu: Menu) {
            menu.clear()
            if (!caret) {
                menu.add(CHROMIUM_GROUP, CHROMIUM_CUT, 1, "Cut")
                menu.add(CHROMIUM_GROUP, CHROMIUM_COPY, 2, copyTitle)
            }
            menu.add(CHROMIUM_GROUP, android.R.id.paste, 3, "Paste")
            menu.add(CHROMIUM_GROUP, android.R.id.pasteAsPlainText, 4, "Paste as plain text")
            if (!caret) menu.add(CHROMIUM_GROUP, CHROMIUM_SHARE, 5, "Share")
            menu.add(CHROMIUM_GROUP, CHROMIUM_SELECT_ALL, 6, "Select all")
        }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            fill(menu)
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            fill(menu)
            return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            clicked += item.itemId
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            destroyed = true
        }
    }

    private class FakeMode : ActionMode() {
        var finished = false
        override fun setTitle(title: CharSequence?) = Unit
        override fun setTitle(resId: Int) = Unit
        override fun setSubtitle(subtitle: CharSequence?) = Unit
        override fun setSubtitle(resId: Int) = Unit
        override fun setCustomView(view: View?) = Unit
        override fun invalidate() = Unit
        override fun finish() {
            finished = true
        }
        override fun getMenu(): Menu? = null
        override fun getTitle(): CharSequence? = null
        override fun getSubtitle(): CharSequence? = null
        override fun getCustomView(): View? = null
        override fun getMenuInflater(): android.view.MenuInflater? = null
    }

    private fun menu(): Menu = PopupMenu(context, View(context)).menu

    private companion object {
        // Chromium's own resource ids (generated, not the framework's), as a real menu has them.
        const val CHROMIUM_GROUP = 0x7f0b0100
        const val CHROMIUM_COPY = 0x7f0b0001
        const val CHROMIUM_CUT = 0x7f0b0002
        const val CHROMIUM_SHARE = 0x7f0b0004
        const val CHROMIUM_SELECT_ALL = 0x7f0b0003
    }

    private fun titles(menu: Menu) = (0 until menu.size()).map { menu.getItem(it).title.toString() }

    @Test
    fun addsTheCopiesAfterCopyAndPutsItsOwnPasteAsPlainText() {
        val inner = WebViewMenu()
        val wrapper = SelectionMenu(inner, Hooks())
        val menu = menu()
        val mode = FakeMode()
        assertTrue(wrapper.onCreateActionMode(mode, menu))
        // Chromium fills the menu again on prepare: the items are there once, still.
        wrapper.onPrepareActionMode(mode, menu)
        wrapper.onPrepareActionMode(mode, menu)
        assertEquals(
            listOf("Cut", "Copy", "Copy as Markdown", "Copy as rich text", "Paste", "Paste as plain text", "Share", "Select all"),
            titles(menu),
        )
        assertNull(menu.findItem(android.R.id.pasteAsPlainText))
        assertNotNull(menu.findItem(SelectionMenu.PASTE_PLAIN))
    }

    @Test
    fun routesItsOwnItemsToTheNoteAndTheRestToTheWebView() {
        val inner = WebViewMenu()
        val hooks = Hooks()
        val wrapper = SelectionMenu(inner, hooks)
        val menu = menu()
        val mode = FakeMode()
        wrapper.onCreateActionMode(mode, menu)
        wrapper.onActionItemClicked(mode, menu.findItem(SelectionMenu.COPY_MARKDOWN))
        wrapper.onActionItemClicked(mode, menu.findItem(SelectionMenu.COPY_RICH))
        wrapper.onActionItemClicked(mode, menu.findItem(SelectionMenu.PASTE_PLAIN))
        assertEquals(listOf(CopyFormat.MARKDOWN, CopyFormat.RICH), hooks.copies)
        assertEquals(1, hooks.pastes)
        assertTrue(mode.finished)
        assertEquals(emptyList<Int>(), inner.clicked)

        wrapper.onActionItemClicked(mode, menu.findItem(CHROMIUM_COPY))
        assertEquals(listOf(CHROMIUM_COPY), inner.clicked)
        wrapper.onDestroyActionMode(mode)
        assertTrue(inner.destroyed)
    }

    @Test
    fun offersNoPasteOnANoteThatCannotChangeAndNoCopiesWithoutASelection() {
        val readOnly = menu()
        SelectionMenu(WebViewMenu(), Hooks(editable = false)).onCreateActionMode(FakeMode(), readOnly)
        assertNull(readOnly.findItem(SelectionMenu.PASTE_PLAIN))
        assertNull(readOnly.findItem(android.R.id.pasteAsPlainText))
        assertNotNull(readOnly.findItem(SelectionMenu.COPY_MARKDOWN))

        // A caret only: the WebView offers Paste and Select all, no Copy, so no copies either.
        val caret = menu()
        SelectionMenu(WebViewMenu(caret = true), Hooks()).onCreateActionMode(FakeMode(), caret)
        assertEquals(listOf("Paste", "Paste as plain text", "Select all"), titles(caret))
    }

    @Test
    fun findsCopyByTheSystemsWordAndOtherwisePutsTheCopiesAtTheEnd() {
        // A phone in German: Chromium's Copy says "Kopieren", as android.R.string.copy does.
        val german = menu()
        SelectionMenu(WebViewMenu(copyTitle = "Kopieren"), Hooks(), copyLabel = "Kopieren").onCreateActionMode(FakeMode(), german)
        assertEquals(listOf("Kopieren", "Copy as Markdown", "Copy as rich text"), titles(german).subList(1, 4))

        // A WebView whose Copy cannot be found, with text selected (it offers Share): at the end.
        val unknown = menu()
        SelectionMenu(WebViewMenu(copyTitle = "Duplicate"), Hooks(), copyLabel = "Copy").onCreateActionMode(FakeMode(), unknown)
        assertEquals(listOf("Copy as Markdown", "Copy as rich text"), titles(unknown).takeLast(2))
    }

    @Test
    fun tellsTheNoteToKeepTheSelectionEachTimeTheMenuShowsBeforeAnyAction() {
        // Review B2: the WebView clears the selection as the menu closes, so the page keeps it
        // when the menu shows, before the item's message.
        val hooks = Hooks()
        val wrapper = SelectionMenu(WebViewMenu(), hooks)
        val menu = menu()
        val mode = FakeMode()
        wrapper.onCreateActionMode(mode, menu)
        wrapper.onPrepareActionMode(mode, menu)
        wrapper.onActionItemClicked(mode, menu.findItem(SelectionMenu.COPY_MARKDOWN))
        assertEquals(listOf("shown", "shown", "copy MARKDOWN"), hooks.events)
    }

    /** Comment (T48): after the copies, or at the end of a caret's menu, only while the note takes comments. */
    @Test
    fun offersCommentAfterTheCopiesAndOpensTheSheet() {
        var comments = 0
        val hooks = object : SelectionHooks by Hooks() {
            override val canComment = true
            override fun comment() {
                comments++
            }
        }
        val menu = menu()
        val mode = FakeMode()
        val wrapper = SelectionMenu(WebViewMenu(), hooks)
        wrapper.onCreateActionMode(mode, menu)
        wrapper.onPrepareActionMode(mode, menu)
        assertEquals(
            listOf("Cut", "Copy", "Copy as Markdown", "Copy as rich text", "Comment", "Paste", "Paste as plain text", "Share", "Select all"),
            titles(menu),
        )
        wrapper.onActionItemClicked(mode, menu.findItem(SelectionMenu.COMMENT))
        assertEquals(1, comments)
        assertTrue(mode.finished)

        val caret = menu()
        SelectionMenu(WebViewMenu(caret = true), hooks).onCreateActionMode(FakeMode(), caret)
        assertEquals("Comment", titles(caret).last())

        // Not on a note that cannot take comments (the source view, read-only, still opening).
        val none = menu()
        SelectionMenu(WebViewMenu(), Hooks()).onCreateActionMode(FakeMode(), none)
        assertNull(none.findItem(SelectionMenu.COMMENT))
    }

    @Test
    fun wrapsTheWebViewsCallbackOnlyWithHooks() {
        val view = SelectionWebView(context)
        val hooks = Hooks()
        // Ctrl+F opens the find bar; F alone or with Shift is typing.
        assertFalse(SelectionWebView.isFind(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F)))
        val ctrlF = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON)
        val ctrlShiftF = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
        assertTrue(SelectionWebView.isFind(ctrlF))
        assertFalse(SelectionWebView.isFind(ctrlShiftF))
        view.hooks = hooks
        assertTrue(view.dispatchKeyEvent(ctrlF))
        assertTrue(view.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON)))
        assertEquals(1, hooks.finds)
        view.destroy()
    }

    @Test
    fun writesRichTextAsHtmlWithItsTextAndTheRestAsPlainText() {
        val rich = NoteClipboard.clipData(ParityFromEditor.Clipboard("n", ClipFormat.RICH, "Bold", "<p><strong>Bold</strong></p>"))
        assertEquals("text/html", rich.description.getMimeType(0))
        assertEquals("Bold", rich.getItemAt(0).text.toString())
        assertEquals("<p><strong>Bold</strong></p>", rich.getItemAt(0).htmlText)

        val markdown = NoteClipboard.clipData(ParityFromEditor.Clipboard("n", ClipFormat.MARKDOWN, "**Bold**"))
        assertEquals("text/plain", markdown.description.getMimeType(0))
        assertEquals("**Bold**", markdown.getItemAt(0).text.toString())
        assertNull(markdown.getItemAt(0).htmlText)
    }

    @Test
    fun putsTheCopyOnTheClipboardAndLeavesSayingSoToAndroid() {
        // Android 13 and later confirm a copy themselves; the app runs on 17 and later (A835).
        val clip = ParityFromEditor.Clipboard("n", ClipFormat.MARKDOWN, "**Bold**")
        assertNull(NoteClipboard.write(context, clip))
        assertEquals("**Bold**", NoteClipboard.text(context))
        assertNull(NoteClipboard.write(context, ParityFromEditor.Clipboard("n", ClipFormat.RICH, "x", "<b>x</b>")))
    }

    @Test
    fun aCopyTooLargeForTheClipboardFallsBackToTextAndOtherwiseSaysSo() {
        // Review S2: Binder refuses a clip over about 1 MB with a RuntimeException.
        val rich = ParityFromEditor.Clipboard("n", ClipFormat.RICH, "text", "<p>html</p>")
        val written = mutableListOf<ClipData>()
        val refusesHtml: (ClipData) -> Unit = { clip ->
            if (clip.description.hasMimeType("text/html")) throw RuntimeException("android.os.TransactionTooLargeException")
            written += clip
        }
        assertEquals(NoteClipboard.TEXT_ONLY, NoteClipboard.write(context, rich, set = refusesHtml))
        assertEquals("text", written.single().getItemAt(0).text.toString())
        val refusesAll: (ClipData) -> Unit = { throw RuntimeException("too large") }
        assertEquals(NoteClipboard.TOO_LARGE, NoteClipboard.write(context, rich, set = refusesAll))
        assertEquals(
            NoteClipboard.TOO_LARGE,
            NoteClipboard.write(context, ParityFromEditor.Clipboard("n", ClipFormat.MARKDOWN, "x"), set = refusesAll),
        )
    }

    @Test
    fun aClipOfAFileIsNotText() {
        // Review S3: a URI clip is never opened, and is not pasted as its address.
        val manager = context.getSystemService(ClipboardManager::class.java)
        manager.setPrimaryClip(ClipData.newRawUri("picture", android.net.Uri.parse("content://media/external/images/1")))
        assertNull(NoteClipboard.text(context))
        // A provider that serves the URI as text (re-review): coerceToText would open it and paste
        // what it reads, on the thread that asked.
        org.robolectric.Robolectric.setupContentProvider(TextClipProvider::class.java, TextClipProvider.AUTHORITY)
        val uri = android.net.Uri.parse("content://${TextClipProvider.AUTHORITY}/1")
        val served = context.contentResolver.openTypedAssetFileDescriptor(uri, "text/*", null)!!
            .createInputStream().use { it.readBytes().decodeToString() }
        assertEquals("secret contents", served)
        manager.setPrimaryClip(ClipData.newRawUri("file", uri))
        assertNull(NoteClipboard.text(context))
    }

    /** Serves every URI as the text "secret contents", as a file manager or notes app might. */
    class TextClipProvider : android.content.ContentProvider() {
        override fun onCreate() = true

        override fun getType(uri: android.net.Uri) = "text/plain"

        override fun getStreamTypes(uri: android.net.Uri, mimeTypeFilter: String) = arrayOf("text/plain")

        override fun openFile(uri: android.net.Uri, mode: String): android.os.ParcelFileDescriptor {
            val file = java.io.File(context!!.cacheDir, "clip.txt").apply { writeText("secret contents") }
            return android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
        }

        override fun openTypedAssetFile(uri: android.net.Uri, mimeTypeFilter: String, opts: android.os.Bundle?) =
            android.content.res.AssetFileDescriptor(openFile(uri, "r"), 0, android.content.res.AssetFileDescriptor.UNKNOWN_LENGTH)

        override fun query(uri: android.net.Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?) = null

        override fun insert(uri: android.net.Uri, values: android.content.ContentValues?) = null

        override fun update(uri: android.net.Uri, values: android.content.ContentValues?, selection: String?, args: Array<out String>?) = 0

        override fun delete(uri: android.net.Uri, selection: String?, args: Array<out String>?) = 0

        companion object {
            const val AUTHORITY = "app.penmoss.test.clip"
        }
    }

    @Test
    fun readsTheClipboardsTextForPasteAsPlainText() {
        val manager = context.getSystemService(ClipboardManager::class.java)
        manager.setPrimaryClip(ClipData.newHtmlText("x", "Heading and text", "<h1>Heading</h1><p>and text</p>"))
        assertEquals("Heading and text", NoteClipboard.text(context))
        manager.setPrimaryClip(ClipData.newPlainText("x", ""))
        assertNull(NoteClipboard.text(context))
    }
}
