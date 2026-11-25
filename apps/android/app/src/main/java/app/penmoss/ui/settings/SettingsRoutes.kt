package app.penmoss.ui.settings

import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import app.penmoss.BuildConfig
import app.penmoss.DeviceGraph
import app.penmoss.NotebookGraph
import app.penmoss.data.NoteStore
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.settings.DadJokes
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLabels
import app.penmoss.engine.settings.Settings
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.string
import app.penmoss.feedback.FeedbackRoutes
import app.penmoss.ui.common.DotState
import app.penmoss.ui.journal.journalToday
import app.penmoss.ui.keys.CommandRoutes
import app.penmoss.ui.keys.ShortcutsRoute
import app.penmoss.ui.open
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import java.time.ZoneId

/*
 * The Settings screens' data (T40 P1; PEN-146): each reads the settings as the phone shows them and
 * changes them: the device's (Appearance, Home, Symbols, Quick Capture, the shortcuts) through
 * `DeviceGraph.changeSetting`, which writes the primary notebook's device map (A1014); Daily Notes'
 * in the primary notebook's own settings (A827). The same routes open from the app's first screen
 * and from a notebook's screens ([SettingsHost]).
 */

/** The Settings screens, in the order the list shows them. */
internal object SettingsRoutes {
    const val HOME = "settings"
    const val APPEARANCE = "settings/appearance"

    /** Settings → Home, the Mac's Sidebar page (its route kept from when it was Display). */
    const val DISPLAY = "settings/display"
    /** Settings → Note (A1634): the Mac's Note page, with Note Width. */
    const val NOTE = "settings/note"
    const val SYMBOLS = "settings/symbols"
    const val DAILY = "settings/daily"
    const val ZONE = "settings/daily/zone"
    const val CAPTURE = "settings/capture"

    /** Settings → AI Descriptions (PEN-161): Describe Notes, when, this phone's provider and key, the prompt. */
    const val AI = "settings/ai-descriptions"

    /** A notebook's page (PEN-146), on a tab: overview, sync or git. */
    const val NOTEBOOK = "settings/git/{id}?tab={tab}"
    const val AGENT_ACTIVITY = AgentActivityRoutes.ACTIVITY
    const val STORAGE = "settings/storage"
    const val GITHUB = "settings/github"

    /** What changed in this version and earlier ones (PEN-109). */
    const val WHATS_NEW = "settings/whatsnew"

    /** Settings → Privacy (PEN-137), and the record it shows as its own screen. */
    const val PRIVACY = "settings/privacy"
    const val PRIVACY_DATA = "settings/privacy/data"

    /** The theme editor for one custom theme (T40 P1b). */
    const val THEME = "settings/appearance/theme/{id}"

    fun theme(id: String) = "settings/appearance/theme/$id"

    /** Add Notebook (A1562): the first run's screens; from the home it ends in the notebook, else on its page. */
    const val ADD_NOTEBOOK = "settings/add-notebook?home={home}"

    fun addNotebook(home: Boolean = false) = "settings/add-notebook?home=$home"

    fun notebook(localId: String, tab: String? = null) = "settings/git/$localId" + (tab?.let { "?tab=$it" } ?: "")
}

/**
 * Where Settings is open (PEN-146): the app's first screen, or a notebook's screens ([notebook]).
 * Both show the same screens over the device and every notebook on the phone.
 */
internal class SettingsHost(
    val device: DeviceGraph,
    val nav: NavHostController,
    val context: Context,
    /** The notebook whose screens Settings opened over; null on the app's first screen. */
    val notebook: NotebookGraph? = null,
    /** Opens Send Feedback over Settings; null where it cannot (the first screen). */
    val openFeedback: ((from: String) -> Unit)? = null,
    /** The notebook's own sync line, which its page's Sync tab says. */
    val syncPass: String? = null,
    /** Opens a notebook's own screens; inside that notebook, goes back to its Home. */
    val openNotebook: (String) -> Unit = { app.penmoss.git.GitNotebookActivity.open(context, it) },
)

/**
 * The primary notebook's graph (A1101), where Daily Notes' settings are; null with no notebook.
 * Its own screens may be closed (Settings over the first screen, or over another notebook): while
 * shown here it is watched, so a pass reads its settings and a change made here is sent (PEN-146).
 */
@Composable
internal fun rememberPrimary(host: SettingsHost): NotebookGraph? {
    val hub = host.device.gitIfAny ?: return host.notebook
    val list by hub.list.collectAsStateWithLifecycle()
    val pick by hub.journalPick.collectAsStateWithLifecycle()
    val primary = remember(list, pick, host.notebook) {
        val id = hub.journal() ?: return@remember host.notebook
        if (host.notebook?.localId == id) host.notebook else runCatching { hub.graph(id) }.getOrNull() ?: host.notebook
    }
    DisposableEffect(primary) {
        // The open notebook's own screens sync it already.
        val release = primary?.takeIf { it !== host.notebook }?.sync?.watch()
        onDispose { release?.invoke() }
    }
    return primary
}

internal fun modeLabel(mode: String) = when (mode) {
    "light" -> "Light"
    "dark" -> "Dark"
    else -> "System"
}

internal fun destinationLabel(destination: String) = if (destination == "inbox") "New Note in Inbox" else "Today’s Note"

/** A notebook as Settings lists it (PEN-146): its row in the Notebooks group. */
data class NotebookEntry(
    val localId: String,
    val name: String,
    val primary: Boolean,
    val status: String,
    val dot: DotState,
    /** Its badge (A1579), before its name as the Mac's nav entry has it. */
    val badge: app.penmoss.engine.settings.NotebookBadge? = null,
)

/** The notebooks' rows, the primary first as the Mac lists them. */
internal fun notebookEntries(
    views: List<GitNotebookView>,
    statuses: Map<String, GitEngineStatus>,
    primary: String?,
    badges: Map<String, app.penmoss.engine.settings.NotebookBadge> = emptyMap(),
    now: Long = System.currentTimeMillis(),
): List<NotebookEntry> =
    views.map { view ->
        val status = statuses[view.localId]
        NotebookEntry(
            view.localId,
            view.name,
            view.localId == primary,
            app.penmoss.git.gitStatusLine(status, view.host, now),
            app.penmoss.git.dotOf(status),
            badges[view.localId] ?: app.penmoss.engine.settings.NotebookBadges.defaultBadge(view.notebookId, view.name),
        )
    }.sortedByDescending { it.primary }

/**
 * The Settings list's groups (PEN-146), each row with a one-line summary of what it holds now
 * (A415): Look and Feel, Writing, Notebooks (each notebook with its sync dot, then All
 * Notebooks), Agents, and This Phone. The version is said once, on What's New.
 */
internal fun settingsGroups(
    /** The device's settings: appearance, Home, symbols, capture, shortcuts. */
    settings: Settings,
    themeName: String,
    /** The primary notebook's settings, which hold Daily Notes'. */
    daily: Settings = settings,
    notebooks: List<NotebookEntry> = emptyList(),
    /** What Storage takes now; null while it is counted. */
    storage: String? = null,
    github: String = "Not Signed In",
    version: String = BuildConfig.VERSION_NAME,
    agentActivity: String = "What agents changed, with Undo",
    /** Whether the usage record is shared, and its size (PEN-137); null leaves Privacy out. */
    privacy: String? = null,
    /** AI Descriptions (PEN-161): on or off, and with which provider. */
    ai: String = "Off",
): List<SettingsGroup> = listOf(
    SettingsGroup(
        "Look and Feel",
        listOf(
            SettingsSection("appearance", "Appearance", "$themeName · ${modeLabel(settings.mode)}", SettingsIcons.Palette, SettingsRoutes.APPEARANCE),
            SettingsSection("home", "Home", displaySummary(settings), SettingsIcons.PanelLeft, SettingsRoutes.DISPLAY),
            SettingsSection("note", "Note", noteSummary(settings.fullWidth), SettingsIcons.Note, SettingsRoutes.NOTE),
            SettingsSection("symbols", "Symbols", symbolsSummary(settings), SettingsIcons.Star, SettingsRoutes.SYMBOLS),
        ),
    ),
    SettingsGroup(
        "Writing",
        listOf(
            SettingsSection("daily", "Daily Notes", daily.timeZone, SettingsIcons.Journal, SettingsRoutes.DAILY),
            SettingsSection("capture", "Quick Capture", destinationLabel(settings.captureDestination), SettingsIcons.Inbox, SettingsRoutes.CAPTURE),
            // A hardware keyboard's shortcuts (T40 P9, ST8): how many the person changed.
            SettingsSection("shortcuts", "Keyboard Shortcuts", shortcutsSummary(settings), SettingsIcons.Keyboard, CommandRoutes.SHORTCUTS),
            SettingsSection("ai-descriptions", "AI Descriptions", ai, SettingsIcons.Sparkle, SettingsRoutes.AI),
        ),
    ),
    SettingsGroup(
        "Notebooks",
        notebooks.map { notebook ->
            SettingsSection(
                "notebook-${notebook.localId}",
                notebook.name,
                if (notebook.primary) "Primary · ${notebook.status}" else notebook.status,
                route = SettingsRoutes.notebook(notebook.localId),
                dot = notebook.dot,
                badge = notebook.badge,
            )
        } + SettingsSection("git", "All Notebooks", app.penmoss.git.gitSummary(notebooks.size), SettingsIcons.Terminal, CommandRoutes.GIT_NOTEBOOKS),
    ),
    SettingsGroup(
        "Agents",
        listOf(SettingsSection("agent-activity", "Agent Activity", agentActivity, SettingsIcons.Spark, SettingsRoutes.AGENT_ACTIVITY)),
    ),
    SettingsGroup(
        "This Phone",
        listOf(
            SettingsSection("storage", "Storage", storage ?: "Counting…", SettingsIcons.Storage, SettingsRoutes.STORAGE),
            SettingsSection("github", "GitHub", github, SettingsIcons.Account, SettingsRoutes.GITHUB),
            SettingsSection("whatsnew", "What’s New", version, SettingsIcons.WhatsNew, SettingsRoutes.WHATS_NEW),
        ) + listOfNotNull(
            // Settings → Privacy (PEN-137): the last of This Phone, as on the Mac's This Mac.
            privacy?.let { SettingsSection("privacy", "Privacy", it, SettingsIcons.Shield, SettingsRoutes.PRIVACY) },
        ),
    ),
)

/** What the Keyboard Shortcuts row says: how many commands' keys the person changed. */
internal fun shortcutsSummary(settings: Settings): String {
    // The ones this phone uses: not a Mac-only binding, nor one it cannot read (review N1).
    val changed = app.penmoss.engine.keys.Bindings.of(app.penmoss.engine.keys.ShortcutCatalogue.bundled, settings.values).usable.size
    return if (changed == 0) "For a hardware keyboard" else "$changed Changed"
}

@Composable
internal fun SettingsHomeRoute(host: SettingsHost, onBack: () -> Unit) {
    val device = host.device
    val state by device.settings.collectAsStateWithLifecycle()
    val appearance by device.appearance.collectAsStateWithLifecycle()
    val themeName = appearance.theme?.get("name")?.jsonPrimitive?.content ?: "Penmoss"
    val hub = device.gitIfAny
    val views = hub?.list?.collectAsStateWithLifecycle()?.value.orEmpty()
    val statuses = hub?.statuses?.collectAsStateWithLifecycle()?.value.orEmpty()
    val badges = hub?.badges?.collectAsStateWithLifecycle(emptyMap())?.value.orEmpty()
    val primary = rememberPrimary(host)
    val daily = primary?.settings?.collectAsStateWithLifecycle()?.value
    var storage by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(views.size) { storage = attachmentSize(storageUse(device).total) }
    val github = FeedbackRoutes.tokenSummary(device.githubToken.accounts().map { it.login })
    val privacy = rememberPrivacySummary(device)
    SettingsHome(
        settingsGroups(
            state.settings,
            themeName,
            daily = daily?.settings ?: state.settings,
            notebooks = notebookEntries(views, statuses, hub?.journal(), badges, app.penmoss.ui.common.rememberNow()),
            storage = storage,
            github = github,
            privacy = privacy,
            ai = app.penmoss.ui.settings.aiSummary(state.settings.values, device.aiDescriptions.ready),
        ),
        onOpen = { route -> host.nav.open(route) },
        onBack = onBack,
        refusal = daily?.refused?.let(::refusalText),
        onDismissRefusal = { primary?.dismissSettingsRefusal() },
    )
}

/** What Settings says of changes the notebook would not take: which, and its reason (A411). */
internal fun refusalText(refusal: NoteStore.SettingsRefusal): String {
    val names = refusal.keys.map(SettingLabels::of).joinToString(", ").ifEmpty { "settings" }
    val reason = refusal.message.trim().removeSuffix(".").ifEmpty { "it was refused" }
    return "Penmoss didn’t take your change to $names, so it was undone: $reason."
}

private fun hex(value: Any?, fallback: Color): Color {
    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return fallback
    if (!Regex("^#[0-9a-fA-F]{6}$").matches(text)) return fallback
    return Color(0xFF000000 or text.removePrefix("#").toLong(16))
}

/** A theme's card: its name and description, and its miniature's colours from its tokens. */
internal fun themeCard(theme: JsonObject, custom: Boolean): ThemeCard {
    fun swatch(variant: String): Swatch {
        val colours = theme[variant] as? JsonObject ?: JsonObject(emptyMap())
        val fallback = if (variant == "dark") Color.Black else Color.White
        val text = if (variant == "dark") Color.White else Color.Black
        return Swatch(
            bg = hex(colours["bg"], fallback),
            sidebar = hex(colours["sidebar"], fallback),
            fg = hex(colours["fg"], text),
            muted = hex(colours["muted"], text),
            border = hex(colours["border"], text),
            accent = hex(colours["accent"], text),
            keyword = hex(colours["codeKeyword"], text),
            string = hex(colours["codeString"], text),
            function = hex(colours["codeFunction"], text),
        )
    }
    fun text(key: String) = (theme[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
    return ThemeCard(text("id"), text("name"), text("description"), custom, swatch("light"), swatch("dark"))
}

@Composable
internal fun AppearanceRoute(graph: DeviceGraph, onEditTheme: (String) -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val catalogue = ThemeCatalogue.bundled
    val settings = state.settings
    val resolved = catalogue.resolve(settings)
    val scope = rememberCoroutineScope()
    val cards = remember(settings) {
        catalogue.builtIns.map { themeCard(it, custom = false) } + settings.customThemes.map { themeCard(it, custom = true) }
    }
    val variant = if (appearance.isDark(isSystemInDarkTheme())) "dark" else "light"
    AppearanceScreen(
        mode = settings.mode,
        systemDark = isSystemInDarkTheme(),
        themes = cards,
        chosen = resolved.id,
        enabled = state.known,
        onMode = { graph.changeSetting(SettingKeys.MODE, JsonPrimitive(it)) },
        onTheme = { graph.changeSetting(SettingKeys.THEME, JsonPrimitive(it)) },
        onBack = onBack,
        // Interface Font, Note Font and Note Font Size (T51, A944), each stored as chosen.
        fonts = FontsUi(
            interfaceFont = settings.interfaceFont,
            noteFont = settings.noteFont,
            noteSize = settings.noteFontSize,
            onInterfaceFont = { graph.changeSetting(SettingKeys.INTERFACE_FONT, JsonPrimitive(it)) },
            onNoteFont = { graph.changeSetting(SettingKeys.NOTE_FONT, JsonPrimitive(it)) },
            onNoteSize = { graph.changeSetting(SettingKeys.NOTE_FONT_SIZE, JsonPrimitive(it)) },
        ),
        editor = ThemeEditorEntry(
            name = resolved.theme.string("name") ?: "this theme",
            builtIn = catalogue.builtIn(resolved.id) != null,
            onOpen = {
                if (catalogue.builtIn(resolved.id) == null) {
                    onEditTheme(resolved.id)
                } else {
                    scope.launch { graph.duplicateTheme(resolved.theme)?.let(onEditTheme) }
                }
            },
        ),
        // The note in the preview is the editor page itself, as the theme editor's (A418).
        notePreview = { modifier -> ThemePreview(resolved.theme, variant, modifier) },
        homeShortcuts = HomeShortcuts.of(settings),
        // This phone's own (A1626): Home's heading a joke, or as it was.
        dadJokes = DadJokes.on(settings),
        onDadJokes = { graph.changeSetting(DadJokes.KEY, JsonPrimitive(it)) },
    )
}

/** The theme editor's screen for the custom theme [id] (T40 P1b, ST5, A417). */
@Composable
internal fun ThemeEditorRoute(graph: DeviceGraph, id: String, onEditTheme: (String) -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val catalogue = ThemeCatalogue.bundled
    val scope = rememberCoroutineScope()
    val custom = state.settings.customThemes
    val theme = custom.firstOrNull { it.string("id") == id }
    ThemeEditorScreen(
        saved = theme,
        catalogue = catalogue,
        otherNames = catalogue.all(state.settings).filter { it.string("id") != id }.mapNotNull { it.string("name") },
        shownVariant = if (appearance.isDark(isSystemInDarkTheme())) "dark" else "light",
        enabled = state.known,
        loaded = state.known,
        onSave = graph::saveTheme,
        onDuplicate = { source -> scope.launch { graph.duplicateTheme(source)?.let(onEditTheme) } },
        onDelete = { deleted ->
            graph.deleteTheme(deleted)
            onBack()
        },
        onBack = onBack,
        preview = { shown, variant, modifier -> ThemePreview(shown, variant, modifier) },
    )
}

/** Today's date in [zone], as the web's Daily notes says it; the default zone when it is unknown here. */
internal fun todayIn(zone: String): String = journalToday(zone).toString()

@Composable
internal fun DailyNotesRoute(host: SettingsHost, onTimeZone: () -> Unit, onBack: () -> Unit) {
    val graph = rememberPrimary(host)
    if (graph == null) {
        // No notebook yet: nothing holds these, so they wait.
        DailyNotesScreen(Settings().timeZone, journalToday(Settings().timeZone), emptyList(), enabled = false, onTimeZone = {}, onSave = { _, _ -> }, onBack = onBack, noNotebook = true)
        return
    }
    val state by graph.settings.collectAsStateWithLifecycle()
    val settings = state.settings
    DailyNotesScreen(
        timeZone = settings.timeZone,
        today = journalToday(settings.timeZone),
        templates = listOf(
            TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", settings.templateOrDefault(SettingKeys.DAILY_TEMPLATE), settings.template(SettingKeys.DAILY_TEMPLATE) != null),
            TemplateField(SettingKeys.WEEKLY_TEMPLATE, "Weekly Template", settings.templateOrDefault(SettingKeys.WEEKLY_TEMPLATE), settings.template(SettingKeys.WEEKLY_TEMPLATE) != null),
        ),
        enabled = state.known,
        onTimeZone = onTimeZone,
        onSave = { key, value -> graph.changeSetting(key, value?.let(::JsonPrimitive)) },
        onBack = onBack,
        phoneZone = ZoneId.systemDefault().id,
        onUsePhoneZone = { graph.changeSetting(SettingKeys.TIME_ZONE, JsonPrimitive(it)) },
        notebook = graph.name,
    )
}

@Composable
internal fun TimeZoneRoute(host: SettingsHost, onBack: () -> Unit) {
    val graph = rememberPrimary(host) ?: return
    val state by graph.settings.collectAsStateWithLifecycle()
    val zones = remember { regionTimeZones() }
    TimeZonePicker(
        current = state.settings.timeZone,
        phoneZone = ZoneId.systemDefault().id,
        zones = zones,
        onPick = { zone ->
            graph.changeSetting(SettingKeys.TIME_ZONE, JsonPrimitive(zone))
            onBack()
        },
        onBack = onBack,
    )
}

@Composable
internal fun QuickCaptureRoute(host: SettingsHost, onNotebooks: () -> Unit, onBack: () -> Unit) {
    val graph = host.device
    val state by graph.settings.collectAsStateWithLifecycle()
    val primary = rememberPrimary(host)
    QuickCaptureScreen(
        destination = state.settings.captureDestination,
        enabled = state.known,
        onChoose = { graph.changeSetting(SettingKeys.CAPTURE, JsonPrimitive(it)) },
        onBack = onBack,
        notebook = primary?.name,
        onNotebook = onNotebooks,
        noNotebook = primary == null,
    )
}

/** Settings → What's New (PEN-109): the cached notes at once, and a fetch at most hourly. */
@Composable
internal fun WhatsNewRoute(onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val store = remember(context) { app.penmoss.updates.ReleaseNotesStore.get(context) }
    val file by store.notes.collectAsStateWithLifecycle()
    val since = remember(store) { store.previousVersion(BuildConfig.VERSION_NAME) }
    LaunchedEffect(store) {
        store.load()
        store.refresh(BuildConfig.VERSION_NAME)
    }
    WhatsNewScreen(
        view = app.penmoss.updates.notesView(file, BuildConfig.VERSION_NAME, since = since),
        onOpenReleases = {
            context.startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(app.penmoss.updates.RELEASES_URL))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        },
        onBack = onBack,
        version = BuildConfig.VERSION_NAME,
    )
}

/**
 * Settings → GitHub (PEN-146): the accounts (several since A1616), Add Account with GitHub's code
 * shown before its page opens, a token instead, and the outbox.
 */
@Composable
internal fun GitHubRoute(host: SettingsHost, onToken: () -> Unit, onFeedbackForm: () -> Unit, onBack: () -> Unit) {
    app.penmoss.feedback.GitHubAccountsRoute(
        host.device,
        onToken = onToken,
        onBack = onBack,
        onSendFeedback = host.openFeedback?.let { open -> { open("Settings → GitHub") } },
        // Feedback still on the phone (A1046), with Retry, Edit and Discard.
        outbox = { host.notebook?.let { app.penmoss.feedback.FeedbackOutboxRoute(it, openForm = onFeedbackForm) } },
    )
}

/**
 * Settings (T40 P1; PEN-146): its list, the device's screens (Appearance, Home, Symbols, Quick
 * Capture and the shortcuts, A827), Daily Notes (the primary notebook's), All Notebooks and each
 * notebook's page, Agent Activity, Storage, GitHub and What's New. The same on the app's first
 * screen and in a notebook's screens.
 */
internal fun NavGraphBuilder.settingsRoutes(host: SettingsHost) {
    val device = host.device
    val nav = host.nav
    fun back(entry: androidx.navigation.NavBackStackEntry) = { leaveSettings(nav, entry) }
    // Settings → Keyboard Shortcuts (T40 P9, ST8, A495).
    composable(CommandRoutes.SHORTCUTS) { entry -> ShortcutsRoute(device, onBack = back(entry)) }
    composable(SettingsRoutes.HOME) { entry -> SettingsHomeRoute(host, onBack = back(entry)) }
    // What agents changed, across notebooks, with Undo (T42, A561; #172, A920; PEN-146).
    composable(SettingsRoutes.AGENT_ACTIVITY) { entry -> AgentActivityRoute(device, onBack = back(entry)) }
    // Settings → All Notebooks (T50 G7, A856; PEN-146): the app's hub, from a notebook's screens too.
    composable(CommandRoutes.GIT_NOTEBOOKS) { entry ->
        val settings by device.settings.collectAsStateWithLifecycle()
        app.penmoss.git.GitNotebooksRoute(
            device.git,
            onOpen = host.openNotebook,
            onBack = back(entry),
            onPage = { nav.open(SettingsRoutes.notebook(it)) },
            copyTags = settings.settings.values[app.penmoss.git.COPY_TAGS_SETTING] != JsonPrimitive(false),
            onCopyTags = { device.changeSetting(app.penmoss.git.COPY_TAGS_SETTING, JsonPrimitive(it)) },
            onAddNotebook = { nav.open(SettingsRoutes.addNotebook()) },
        )
    }
    // Add Notebook (A1562): the first run's own screens, starting at Create or Open Notebook.
    composable(
        SettingsRoutes.ADD_NOTEBOOK,
        arguments = listOf(navArgument("home") { type = NavType.BoolType; defaultValue = false }),
    ) { entry ->
        val home = entry.arguments?.getBoolean("home") == true
        app.penmoss.git.firstrun.NotebookSteps(
            app.penmoss.git.firstrun.rememberFirstRunDeps(device),
            firstRun = false,
            onCancel = { nav.popBackStack() },
            onDone = { localId ->
                nav.popBackStack()
                if (localId != null) {
                    if (home) host.openNotebook(localId) else nav.open(SettingsRoutes.notebook(localId))
                }
            },
        )
    }
    composable(
        SettingsRoutes.NOTEBOOK,
        arguments = listOf(
            navArgument("id") { type = NavType.StringType },
            navArgument("tab") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            },
        ),
    ) { entry ->
        val id = entry.arguments?.getString("id").orEmpty()
        app.penmoss.git.NotebookPageRoute(
            device.git,
            id,
            entry.arguments?.getString("tab"),
            onOpen = host.openNotebook,
            onBack = back(entry),
            passText = host.syncPass.takeIf { host.notebook?.localId == id },
        )
    }
    // Appearance, Home, Symbols, Quick Capture and the shortcuts are the device's (A827).
    composable(SettingsRoutes.APPEARANCE) { entry ->
        AppearanceRoute(device, onEditTheme = { nav.open(SettingsRoutes.theme(it)) }, onBack = back(entry))
    }
    composable(SettingsRoutes.THEME, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id").orEmpty()
        ThemeEditorRoute(device, id, onEditTheme = { nav.open(SettingsRoutes.theme(it)) }, onBack = back(entry))
    }
    composable(SettingsRoutes.DAILY) { entry -> DailyNotesRoute(host, onTimeZone = { nav.open(SettingsRoutes.ZONE) }, onBack = back(entry)) }
    composable(SettingsRoutes.ZONE) { entry -> TimeZoneRoute(host, onBack = back(entry)) }
    composable(SettingsRoutes.CAPTURE) { entry -> QuickCaptureRoute(host, onNotebooks = { nav.open(CommandRoutes.GIT_NOTEBOOKS) }, onBack = back(entry)) }
    composable(SettingsRoutes.AI) { entry -> AiDescriptionsRoute(host, onBack = back(entry)) }
    // What changed in this version and earlier ones (PEN-109).
    composable(SettingsRoutes.WHATS_NEW) { entry -> WhatsNewRoute(onBack = back(entry)) }
    // Settings → Privacy and its Analytics Data (PEN-137).
    composable(SettingsRoutes.PRIVACY) { entry -> PrivacyRoute(device, onViewData = { nav.open(SettingsRoutes.PRIVACY_DATA) }, onBack = back(entry)) }
    composable(SettingsRoutes.PRIVACY_DATA) { entry -> AnalyticsDataRoute(device, onBack = back(entry)) }
    // This phone's storage (T40 P8; PEN-146), apart from any notebook's sync.
    composable(SettingsRoutes.STORAGE) { entry -> StorageRoute(device, onBack = back(entry)) }
    // Home's shortcuts and sections, synced with the Mac's sidebar (T42, A576; T40 ST12, A650).
    composable(SettingsRoutes.DISPLAY) { entry -> DisplayRoute(device, onBack = back(entry), notebook = host.notebook) }
    composable(SettingsRoutes.NOTE) { entry -> NoteSettingsRoute(device, onBack = back(entry)) }
    // The line symbols, synced with the Mac's (T44, ST13, A747).
    composable(SettingsRoutes.SYMBOLS) { entry ->
        SymbolsRoute(device, onShortcuts = { nav.open(CommandRoutes.SHORTCUTS) }, onBack = back(entry))
    }
    // Settings → GitHub (PEN-146), and About's old route, which opens it.
    for (route in listOf(SettingsRoutes.GITHUB, FeedbackRoutes.ABOUT)) {
        composable(route) { entry ->
            GitHubRoute(host, onToken = { nav.open(FeedbackRoutes.GITHUB_TOKEN) }, onFeedbackForm = { nav.open(FeedbackRoutes.FORM) }, onBack = back(entry))
        }
    }
    // Settings → GitHub → Use a Token Instead… (A1012).
    composable(FeedbackRoutes.GITHUB_TOKEN) { entry -> app.penmoss.feedback.GitHubTokenRoute(device, onBack = back(entry)) }
}

/**
 * Leaves [entry]'s screen (its Back button), only while it is the settled screen in front (T39,
 * A387): two quick taps on Back used to pop the screen under it too.
 */
private fun leaveSettings(nav: NavHostController, entry: androidx.navigation.NavBackStackEntry) {
    if (entry.lifecycle.currentState != androidx.lifecycle.Lifecycle.State.RESUMED || nav.currentBackStackEntry != entry) return
    nav.popBackStack()
}

/** Send Feedback's form (T49, D41), over the notebook's screen it was opened from. */
internal fun NavGraphBuilder.feedbackRoutes(root: app.penmoss.ui.RootUi) {
    val graph = root.graph
    val nav = root.nav
    // Send feedback (T49, D41): over the screen it was opened from, captured first.
    composable(FeedbackRoutes.FORM) { entry ->
        app.penmoss.feedback.FeedbackRoute(graph, onClose = { leaveSettings(nav, entry) })
    }
}
