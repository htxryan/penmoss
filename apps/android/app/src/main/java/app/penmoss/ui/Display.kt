package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import androidx.compose.runtime.Immutable
import app.penmoss.engine.settings.DisplayKeys
import app.penmoss.engine.settings.SidebarLayout
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.settings.DisplayScreen
import kotlinx.serialization.json.JsonPrimitive

/*
 * Settings → Display on the phone (T42, A576; T40 ST12, A650): the web's synced `sidebar.*`
 * settings, read by Home. The phone's shortcuts are Home's row of icons (T51, A932): Search,
 * which always shows, then Today, This Week, Graph and Commands. A hidden shortcut still runs
 * from its keys, Search's actions and the launcher, as on the web.
 */

/** Which of Home's shortcuts show. */
data class HomeShortcuts(
    val today: Boolean = true,
    val thisWeek: Boolean = true,
    val graph: Boolean = true,
    val commands: Boolean = true,
) {
    companion object {
        fun of(settings: Settings) = HomeShortcuts(
            today = settings.shows(DisplayKeys.TODAY),
            thisWeek = settings.shows(DisplayKeys.THIS_WEEK),
            graph = settings.shows(DisplayKeys.GRAPH),
            commands = settings.shows(DisplayKeys.COMMANDS),
        )
    }
}

/** One Display switch: its setting, its name, and where it shows on the phone. */
data class DisplayChoice(val key: String, val label: String, val where: String, val shown: Boolean)

/** The Display switches, in the web's order, with where each shortcut is on the phone. */
fun displayChoices(settings: Settings): List<DisplayChoice> = listOf(
    DisplayChoice(DisplayKeys.TODAY, "Today", "An icon in Home’s row", settings.shows(DisplayKeys.TODAY)),
    DisplayChoice(DisplayKeys.THIS_WEEK, "This Week", "An icon in Home’s row", settings.shows(DisplayKeys.THIS_WEEK)),
    DisplayChoice(DisplayKeys.GRAPH, "Graph", "An icon in Home’s row", settings.shows(DisplayKeys.GRAPH)),
    DisplayChoice(DisplayKeys.COMMANDS, "Commands", "An icon in Home’s row: Search with every action", settings.shows(DisplayKeys.COMMANDS)),
)

/** What the Settings home says of Display: which shortcuts are hidden. */
fun displaySummary(settings: Settings): String {
    val hidden = displayChoices(settings).filterNot { it.shown }.map { it.label }
    return if (hidden.isEmpty()) "Every shortcut on Home" else "Hidden: ${hidden.joinToString(", ")}"
}

@Composable
internal fun DisplayRoute(graph: AppGraph, onBack: () -> Unit) {
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
        onRecentCount = { graph.changeSetting(SettingKeys.RECENT_COUNT, JsonPrimitive(it)) },
        onQuickAccessNotebook = { graph.changeSetting(SettingKeys.QUICK_ACCESS_NOTEBOOK, JsonPrimitive(it)) },
    )
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
