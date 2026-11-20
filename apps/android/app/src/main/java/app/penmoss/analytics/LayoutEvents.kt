package app.penmoss.analytics

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * The `app layout` event for a notebook's screens (PEN-174): the drawer shown or hidden (it has no
 * width of its own, so no `sidebarWidth`), the shown note's panel open or closed (`none` with no
 * note in front), Full Width, and the theme's mode as chosen. There are no tabs on a phone, so no
 * `tabs`. Recorded once the settings are read, then [SETTLE_MS] after the last change, and only
 * when it differs from the last one recorded for the main window in this session; a setting or a
 * click a change records already comes first.
 *
 * The launcher's screens (the first run, the consent question, All Notebooks) have no drawer,
 * panel or note, so they record no layout.
 */
class LayoutEvents(
    private val settle: Settle = Settle.main(),
    private val record: (Map<String, Any?>) -> Boolean = { Analytics.record("app", "layout", it) },
    private val session: () -> String? = { Analytics.service?.session },
) {
    private var drawer: Any? = null
    private var panel: Pair<Any, Boolean>? = null
    private var fullWidth: Boolean? = null
    private var themeMode: String? = null

    /** The drawer of the screen that [owner] is: open or closed. */
    fun drawer(owner: Any, open: Boolean) {
        drawer = if (open) owner else drawer.takeUnless { it === owner }
        changed()
    }

    /** [owner]'s screen went: its drawer with it. */
    fun drawerGone(owner: Any) {
        if (drawer === owner) drawer = null
        changed()
    }

    /** The note on screen ([owner], one note screen) has its panel open or closed. */
    fun panel(owner: Any, open: Boolean) {
        panel = owner to open
        changed()
    }

    /** [owner]'s note left the screen; another note that came in front keeps its own. */
    fun panelGone(owner: Any) {
        if (panel?.first === owner) panel = null
        changed()
    }

    /** The settings it shows: Full Width and the theme's mode (light, dark or system). */
    fun settings(fullWidth: Boolean, themeMode: String) {
        this.fullWidth = fullWidth
        this.themeMode = themeMode.takeIf { it in AnalyticsCatalogue.THEME_MODES } ?: "system"
        changed()
    }

    fun stop() = settle.cancel()

    /** The layout now, or null until the settings are read. */
    fun props(): Map<String, Any?>? {
        val full = fullWidth ?: return null
        val mode = themeMode ?: return null
        return mapOf(
            "window" to WINDOW,
            "sidebar" to if (drawer != null) "shown" else "hidden",
            "panel" to when (panel?.second) {
                true -> "open"
                false -> "closed"
                null -> "none"
            },
            "fullWidth" to full,
            "themeMode" to mode,
        )
    }

    private fun changed() {
        if (props() == null) return
        settle.after(SETTLE_MS) { recordNow() }
    }

    private fun recordNow() {
        val props = props() ?: return
        val now = session()
        if (!LAST.isNew(now, WINDOW, props)) return
        if (record(props)) LAST.kept(now, WINDOW, props)
    }

    companion object {
        const val SETTLE_MS = 500L
        private const val WINDOW = "main"

        internal val LAST = LastRecorded()
    }
}

/** The notebook screens' layout recorder; null outside them (the launcher, previews, tests). */
val LocalLayoutEvents = staticCompositionLocalOf<LayoutEvents?> { null }

/** Records the layout of [graph]'s screens in [content] (PEN-174). */
@Composable
fun TrackLayout(graph: NotebookGraph, content: @Composable () -> Unit) {
    val layout = remember { LayoutEvents() }
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val fullWidth by remember(graph) { graph.device.settings.map { it.settings.fullWidth }.distinctUntilChanged() }.collectAsStateWithLifecycle(null)
    LaunchedEffect(layout, fullWidth, appearance.mode) { fullWidth?.let { layout.settings(it, appearance.mode) } }
    DisposableEffect(layout) { onDispose { layout.stop() } }
    CompositionLocalProvider(LocalLayoutEvents provides layout, content = content)
}

/** A screen's drawer, open or closed, for the layout; gone with the screen. */
@Composable
fun TrackDrawer(open: Boolean) {
    val layout = LocalLayoutEvents.current ?: return
    val owner = remember { Any() }
    LaunchedEffect(layout, open) { layout.drawer(owner, open) }
    DisposableEffect(layout) { onDispose { layout.drawerGone(owner) } }
}

/** The note on screen's panel, open or closed, for the layout; gone with the note screen. */
@Composable
fun TrackNotePanel(open: Boolean) {
    val layout = LocalLayoutEvents.current ?: return
    val owner = remember { Any() }
    LaunchedEffect(layout, open) { layout.panel(owner, open) }
    DisposableEffect(layout) { onDispose { layout.panelGone(owner) } }
}
