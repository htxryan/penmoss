package app.penmoss.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import androidx.compose.runtime.Immutable
import app.penmoss.engine.settings.DisplayKeys
import app.penmoss.engine.settings.SidebarLayout
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.settings.DisplayScreen
import kotlinx.serialization.json.JsonPrimitive

/*
 * Settings → Home on the phone (T42, A576; T40 ST12, A650; PEN-146): the Mac's Sidebar page, the
 * synced `sidebar.*` settings Home reads. The phone's shortcuts are Home's row of icons (T51,
 * A932): Search, which always shows, then Tags (A1438), Today, This Week, Graph and Commands. A
 * hidden shortcut still runs from its keys, Search's actions and the launcher, as on the Mac.
 */

/** Which of Home's shortcuts show. */
data class HomeShortcuts(
    val tags: Boolean = true,
    val today: Boolean = true,
    val thisWeek: Boolean = true,
    val graph: Boolean = true,
    val commands: Boolean = true,
) {
    companion object {
        fun of(settings: Settings) = HomeShortcuts(
            tags = settings.shows(DisplayKeys.TAGS),
            today = settings.shows(DisplayKeys.TODAY),
            thisWeek = settings.shows(DisplayKeys.THIS_WEEK),
            graph = settings.shows(DisplayKeys.GRAPH),
            commands = settings.shows(DisplayKeys.COMMANDS),
        )
    }
}

/** One of Home's shortcut switches: its setting, its name, and whether it shows. */
data class DisplayChoice(val key: String, val label: String, val shown: Boolean)

/** Home's shortcut switches, in the Mac's sidebar order (core's `SIDEBAR_ITEMS`). */
fun displayChoices(settings: Settings): List<DisplayChoice> = listOf(
    DisplayChoice(DisplayKeys.TAGS, "Tags", settings.shows(DisplayKeys.TAGS)),
    DisplayChoice(DisplayKeys.TODAY, "Today", settings.shows(DisplayKeys.TODAY)),
    DisplayChoice(DisplayKeys.THIS_WEEK, "This Week", settings.shows(DisplayKeys.THIS_WEEK)),
    DisplayChoice(DisplayKeys.GRAPH, "Graph", settings.shows(DisplayKeys.GRAPH)),
    DisplayChoice(DisplayKeys.COMMANDS, "Commands", settings.shows(DisplayKeys.COMMANDS)),
)

/** What the Settings list says of Home: which shortcuts are hidden. */
fun displaySummary(settings: Settings): String {
    val hidden = displayChoices(settings).filterNot { it.shown }.map { it.label }
    return if (hidden.isEmpty()) "Every shortcut on Home" else "Hidden: ${hidden.joinToString(", ")}"
}

@Composable
internal fun DisplayRoute(graph: app.penmoss.DeviceGraph, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    DisplayScreen(
        choices = displayChoices(state.settings),
        enabled = state.known,
        // Shown again is stored as true, as the web stores it, so another device's copy never wins.
        onChange = { key, shown -> graph.changeSetting(key, JsonPrimitive(shown)) },
        onBack = onBack,
        layout = HomeLayout.of(state.settings),
        onSectionHidden = { section, hide ->
            graph.changeSetting(SettingKeys.HIDDEN_SECTIONS, SidebarLayout.toJson(SidebarLayout.withHidden(state.settings.hiddenSections, section, hide)))
        },
        onSectionOrder = { home -> graph.changeSetting(SettingKeys.SECTION_ORDER, SidebarLayout.toJson(withHomeOrder(state.settings.sectionOrder, home))) },
        onRecentCount = { graph.changeSetting(SettingKeys.RECENT_COUNT, JsonPrimitive(it)) },
        onQuickAccessNotebook = { graph.changeSetting(SettingKeys.QUICK_ACCESS_NOTEBOOK, JsonPrimitive(it)) },
    )
}

/**
 * Every section in order with Home's ([home], dragged into a new order) put back in their places:
 * the Mac's Calendar and Tags keep their slots among them (PEN-146).
 */
fun withHomeOrder(order: List<String>, home: List<String>): List<String> {
    val next = home.iterator()
    return order.map { if (it in home && next.hasNext()) next.next() else it }
}

/**
 * The sidebar's sections on Home (T53 item 8, A983), by the synced settings the web's sidebar
 * reads: Home has Quick Access, Notebooks and Recent Notes (the calendar and tags are screens of
 * their own), in the person's order, each hidden or shown; Recent Notes' length; and whether Quick
 * Access names each note's notebook (T53 item 10).
 */
@Immutable
data class HomeLayout(
    val order: List<String> = SidebarLayout.SECTIONS,
    val hidden: Set<String> = emptySet(),
    val recentCount: Int = SidebarLayout.RECENT_DEFAULT,
    val quickAccessNotebook: Boolean = false,
) {
    /** Home's sections that show, in order. */
    val shown: List<String> get() = order.filter { it in HOME_SECTIONS && it !in hidden }

    companion object {
        /** The sections Home has. */
        val HOME_SECTIONS = listOf(SidebarLayout.QUICK_ACCESS, SidebarLayout.NOTEBOOKS, SidebarLayout.RECENT)

        fun of(settings: Settings) = HomeLayout(
            order = settings.sectionOrder,
            hidden = settings.hiddenSections,
            recentCount = settings.recentCount,
            quickAccessNotebook = settings.quickAccessShowsNotebook,
        )
    }
}
