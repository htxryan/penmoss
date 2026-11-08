package app.penmoss.editor

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Rect
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView
import app.penmoss.engine.bridge.ClipFormat
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.ParityFromEditor

/** What the note screen does for the editor's selection menu and keys (T40 P8, ED9, ED11, ED18). */
interface SelectionHooks {
    /** Copy the selection as Markdown or rich text. */
    fun copyAs(format: CopyFormat)

    /** Paste the clipboard's text as plain text, as ⌘⇧V does on the web. */
    fun pastePlain()

    /** Ctrl+F with a hardware keyboard: open the find bar. */
    fun find()

    /**
     * The selection menu opened or changed (review B2): the page keeps what is selected now,
     * and where, since the WebView clears the selection as the menu closes.
     */
    fun menuShown() {}

    /** The note can be changed now: Paste as plain text is offered only then. */
    val editable: Boolean

    /** Comment (T48): the Comments sheet with a new thread on the selection, or at the caret. */
    fun comment() {}

    /** The note takes comments now: Comment is offered only then. */
    val canComment: Boolean get() = false
}

/**
 * The editor's WebView (T32), with the selection menu and keys the note screen adds (T40 P8):
 * Copy as Markdown and Copy as rich text after Copy, Penmoss's own Paste as plain text in place
 * of the system's (which pastes `text/plain` the editor would read as markdown), and Ctrl+F.
 * Without [hooks] (the theme preview) it is a plain WebView.
 */
@SuppressLint("ViewConstructor")
class SelectionWebView(context: Context) : WebView(context) {
    var hooks: SelectionHooks? = null

    /** The note's editor page, which dispatches its own keys (A493); the graph's and preview's do not (A555). */
    var dispatchesKeys = false

    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? =
        super.startActionMode(wrap(callback), type)

    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? = super.startActionMode(wrap(callback))

    private fun wrap(callback: ActionMode.Callback?): ActionMode.Callback? {
        val hooks = hooks ?: return callback
        return callback?.let {
            SelectionMenu(it, hooks, context.getString(android.R.string.copy), context.getString(android.R.string.cut))
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val hooks = hooks
        if (hooks != null && isFind(event)) {
            if (event.action == KeyEvent.ACTION_DOWN) hooks.find()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    companion object {
        /** Ctrl+F and nothing else held: the find bar (the WebView itself has no find UI). */
        fun isFind(event: KeyEvent): Boolean =
            event.keyCode == KeyEvent.KEYCODE_F && event.isCtrlPressed && !event.isAltPressed &&
                !event.isShiftPressed && !event.isMetaPressed
    }
}

/**
 * Wraps the WebView's own selection menu (T40 P8, ED9, ED11). Chromium fills the menu in both
 * create and prepare, so the items are added (once) after each; anything not ours goes to the
 * WebView's callback. Chromium's Copy has an id of its own (`R.id.select_action_menu_copy`),
 * not `android.R.id.copy`, so Copy is found by its title too (review B1); with no Copy at all
 * but a selection to act on, the copies go at the end. Each time the menu shows, the page is
 * told to keep the selection (B2). If a WebView version drops the extra items, the note's ⋮
 * menu still has Copy note as Markdown and as rich text.
 */
class SelectionMenu(
    private val inner: ActionMode.Callback,
    private val hooks: SelectionHooks,
    /** The system's word for Copy (`android.R.string.copy`), which Chromium's item shows. */
    private val copyLabel: String = "Copy",
    /** The system's word for Cut (`android.R.string.cut`): a menu with Cut is for a selection. */
    private val cutLabel: String = "Cut",
) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        val shown = inner.onCreateActionMode(mode, menu)
        if (shown) {
            amend(menu)
            hooks.menuShown()
        }
        return shown
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        inner.onPrepareActionMode(mode, menu)
        amend(menu)
        hooks.menuShown()
        // The menu may have changed here even when the WebView's own items did not.
        return true
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        when (item.itemId) {
            COPY_MARKDOWN -> hooks.copyAs(CopyFormat.MARKDOWN)
            COPY_RICH -> hooks.copyAs(CopyFormat.RICH)
            PASTE_PLAIN -> hooks.pastePlain()
            COMMENT -> hooks.comment()
            else -> return inner.onActionItemClicked(mode, item)
        }
        mode.finish()
        return true
    }

    override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
        if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect) else super.onGetContentRect(mode, view, outRect)
    }

    /** Chromium's Copy (its own id, the system's title), or the framework's. */
    private fun copyItem(menu: Menu): MenuItem? {
        menu.findItem(android.R.id.copy)?.let { return it }
        return (0 until menu.size()).map(menu::getItem).firstOrNull { item ->
            val title = item.title?.toString()?.trim().orEmpty()
            title.equals(copyLabel, ignoreCase = true) || title.equals("Copy", ignoreCase = true)
        }
    }

    /** Whether the menu is for a selection: it offers Cut or Share, which a caret's never does. */
    private fun hasSelection(menu: Menu): Boolean = (0 until menu.size()).map(menu::getItem).any { item ->
        val title = item.title?.toString()?.trim().orEmpty()
        item.itemId == android.R.id.cut || item.itemId == android.R.id.shareText ||
            title.equals(cutLabel, ignoreCase = true) || SELECTION_TITLES.any { title.equals(it, ignoreCase = true) }
    }

    /** Adds the copies after Copy, and puts Penmoss's Paste as plain text in place of the system's. */
    fun amend(menu: Menu) {
        if (menu.findItem(COPY_MARKDOWN) == null) {
            val copy = copyItem(menu)
            when {
                copy != null -> {
                    menu.add(copy.groupId, COPY_MARKDOWN, copy.order, COPY_MARKDOWN_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                    menu.add(copy.groupId, COPY_RICH, copy.order, COPY_RICH_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                }
                // No Copy found (another WebView's menu) but text is selected: at the end.
                hasSelection(menu) -> {
                    menu.add(Menu.NONE, COPY_MARKDOWN, Menu.CATEGORY_SECONDARY, COPY_MARKDOWN_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                    menu.add(Menu.NONE, COPY_RICH, Menu.CATEGORY_SECONDARY, COPY_RICH_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                }
            }
        }
        // Comment (T48), after the copies, or at the end of a caret's menu.
        if (hooks.canComment && menu.findItem(COMMENT) == null) {
            val copy = copyItem(menu)
            if (copy != null) {
                menu.add(copy.groupId, COMMENT, copy.order, COMMENT_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
            } else {
                menu.add(Menu.NONE, COMMENT, Menu.CATEGORY_SECONDARY, COMMENT_LABEL).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
            }
        }
        val system = menu.findItem(android.R.id.pasteAsPlainText)
        if (system != null) {
            menu.removeItem(android.R.id.pasteAsPlainText)
            if (hooks.editable && menu.findItem(PASTE_PLAIN) == null) {
                menu.add(system.groupId, PASTE_PLAIN, system.order, PASTE_PLAIN_LABEL)
            }
        }
    }

    companion object {
        // Ids of our own, clear of the framework's (android.R.id.*) and of Chromium's menu ids.
        const val COPY_MARKDOWN = 0x50e0_0001
        const val COPY_RICH = 0x50e0_0002
        const val PASTE_PLAIN = 0x50e0_0003
        const val COMMENT = 0x50e0_0004
        const val COMMENT_LABEL = "Comment"
        const val COPY_MARKDOWN_LABEL = "Copy as Markdown"
        const val COPY_RICH_LABEL = "Copy as rich text"
        const val PASTE_PLAIN_LABEL = "Paste as plain text"

        /** Items only a selection's menu has (Chromium's own ids, so by title), besides Cut. */
        private val SELECTION_TITLES = listOf("Cut", "Share", "Web search")
    }
}

/** The system clipboard for the editor (T40 P8, ED9, ED11). */
object NoteClipboard {
    private const val LABEL = "Penmoss"

    /**
     * Writes what the page asked for: HTML with its readable text for rich text, plain text
     * otherwise. Returns what to tell the person when the copy fell short, else null: Android
     * shows its own copied confirmation (every version the app runs on, A835).
     */
    fun write(
        context: Context,
        clip: ParityFromEditor.Clipboard,
        /** Tests: the clipboard's own write, which Binder can refuse. */
        set: ((ClipData) -> Unit)? = null,
    ): String? {
        val manager = context.getSystemService(ClipboardManager::class.java)
        val write = set ?: manager?.let { it::setPrimaryClip } ?: return "Copying wasn't allowed here"
        // A long note as rich text can pass Binder's 1 MB limit (review S2): the text alone, then a word.
        if (runCatching { write(clipData(clip)) }.isFailure) {
            if (clip.html == null || runCatching { write(ClipData.newPlainText(LABEL, clip.text)) }.isFailure) return TOO_LARGE
            return TEXT_ONLY
        }
        return null
    }

    fun clipData(clip: ParityFromEditor.Clipboard): ClipData {
        val html = clip.html
        return if (clip.format == ClipFormat.RICH && html != null) {
            ClipData.newHtmlText(LABEL, clip.text, html)
        } else {
            ClipData.newPlainText(LABEL, clip.text)
        }
    }

    /** What a copy too large for the clipboard says. */
    const val TOO_LARGE = "That's too much to copy here. Copy less of the note."

    /** What a rich copy too large for the clipboard says when its text went instead. */
    const val TEXT_ONLY = "Copied as text: the rich text was too large to copy."

    /**
     * The clipboard's text, as plain text (HTML read as its text), or null: a clip of a file or
     * picture (a URI) is not text, and is never opened (review S3). Read it off the main thread.
     */
    fun text(context: Context): String? {
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return null
        val item = manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return null
        val text = item.text?.toString()
            ?: item.htmlText?.let { android.text.Html.fromHtml(it, android.text.Html.FROM_HTML_MODE_LEGACY).toString().trim() }
        return text?.takeIf { it.isNotEmpty() }
    }
}
