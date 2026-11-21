package app.penmoss.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.EventState
import app.penmoss.analytics.Limits
import app.penmoss.editor.WebPictureSetting
import app.penmoss.engine.keys.Bindings
import app.penmoss.engine.keys.ShortcutCatalogue
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.feedback.GitHubAccount
import app.penmoss.feedback.GitHubScreen
import app.penmoss.feedback.SignInState
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.git.GitNotebooksActions
import app.penmoss.git.GitNotebooksScreen
import app.penmoss.git.GitNotebooksUi
import app.penmoss.git.GitRow
import app.penmoss.git.NotebookPage
import app.penmoss.git.NotebookTab
import app.penmoss.ui.TitleCase
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.keys.KeyChars
import app.penmoss.ui.keys.ShortcutsScreen
import app.penmoss.updates.notesView
import app.penmoss.updates.parseNotes
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Every Settings screen on the phone names its controls in Title Case (PEN-137, AC43; A938 as
 * amended), as `settings-title-case.spec.ts` holds the Mac's: each screen is shown, the screen's
 * title, every heading, and every control's label (a button's, a switch's, a check box's, a
 * radio button's, a tab's, a row's headline; an icon button's name) is read from the semantics
 * tree and held to [TitleCase], core's rule. A row's supporting line, hints and sentences are not
 * read. Words written their own way (penmoss, GitHub, ⌘K, a path) keep their spelling, by the rule.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsTitleCaseTest {
    @get:Rule
    val compose = createComposeRule()

    private val catalogue = ThemeCatalogue.bundled
    private val cards = catalogue.builtIns.map { themeCard(it, custom = false) }
    private val notebook = GitNotebookView(
        localId = "01JBL0000000000000000000L1",
        notebookId = "01JBN0000000000000000000N1",
        name = "Work",
        create = false,
        remote = "https://github.com/htxryan/work",
        repository = "github.com/htxryan/work",
        host = "github.com",
        branch = "main",
        dir = "docs/notes",
        pushDelayS = 60,
        pullEveryMin = 2,
        wifiOnly = false,
        hasToken = true,
    )
    private val notebooks = GitNotebooksUi(rows = listOf(GitRow(notebook, null)))
    private val releaseNotes = parseNotes(
        """{"schema":1,"releases":[{"version":"0.2.0","tag":"v0.2.0","build":1170,"date":"2026-11-08"},{"version":"0.2.1","tag":"v0.2.1","build":1180,"date":"2026-11-20"}],
        "notes":[{"build":1165,"pr":1,"kind":"new","platform":null,"text":"Quick capture."},
        {"build":1176,"pr":4,"kind":"fixed","platform":"android","text":"The keyboard stays down."}]}""",
    )

    /** Every Settings screen, by its name in a failure. */
    private val screens: List<Pair<String, @Composable () -> Unit>> = listOf(
        "Settings" to {
            SettingsHome(
                settingsGroups(
                    Settings(JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark")))),
                    "Nord",
                    notebooks = listOf(
                        NotebookEntry("n1", "Personal", primary = true, status = "Synced at 4:12 PM", dot = DotState.SYNCED),
                        NotebookEntry("n2", "Work", primary = false, status = "Not Synced Yet", dot = DotState.IDLE),
                    ),
                    storage = "79 MB",
                    privacy = privacySummary(true, 255),
                ),
                onOpen = {},
                onBack = {},
            )
        },
        "Appearance" to {
            AppearanceScreen("system", systemDark = false, themes = cards, chosen = "penmoss", enabled = true, onMode = {}, onTheme = {}, onBack = {})
        },
        "Theme Editor" to {
            ThemeEditorScreen(
                saved = ThemeEdits.duplicate(catalogue.builtIn("nord")!!, "custom-abc", "Nord Copy", catalogue),
                catalogue = catalogue,
                otherNames = listOf("Nord", "Paper"),
                shownVariant = "light",
                enabled = true,
                onSave = {},
                onDuplicate = {},
                onDelete = {},
                onBack = {},
                preview = { _, _, _ -> },
            )
        },
        "Home" to { DisplayScreen(displayChoices(Settings()), enabled = true, onChange = { _, _ -> }, onBack = {}) },
        "Note" to { NoteSettingsScreen(fullWidth = false, editorWidth = 52, enabled = true, onFullWidth = {}, onBack = {}) },
        "Symbols" to {
            SymbolsScreen(symbols = LineSymbols.DEFAULTS, custom = false, enabled = true, onChange = { null }, onReset = {}, onShortcuts = {}, onBack = {})
        },
        "Daily Notes" to {
            DailyNotesScreen(
                timeZone = "America/Chicago",
                today = java.time.LocalDate.of(2026, 11, 15),
                templates = listOf(
                    TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", "## Plan\n", custom = true),
                    TemplateField(SettingKeys.WEEKLY_TEMPLATE, "Weekly Template", "## Goals\n", custom = false),
                ),
                enabled = true,
                onTimeZone = {},
                onSave = { _, _ -> },
                onBack = {},
                phoneZone = "Europe/London",
            )
        },
        "Time Zone" to {
            TimeZonePicker(current = "America/Chicago", phoneZone = "Europe/London", zones = regionTimeZones().take(20), onPick = {}, onBack = {})
        },
        "Quick Capture" to {
            QuickCaptureScreen("daily", enabled = true, onChoose = {}, onBack = {}, notebook = "Personal", onNotebook = {})
        },
        "Keyboard Shortcuts" to {
            ShortcutsScreen(bindings = Bindings(ShortcutCatalogue.bundled, emptyMap()), keyboard = true, canChange = true, onSet = { _, _ -> }, onBack = {}, chars = KeyChars { 0 })
        },
        "All Notebooks" to { GitNotebooksScreen(notebooks, GitNotebooksActions(), onBack = {}) },
        "A Notebook: Overview" to { NotebookPage(notebooks.rows.first(), notebooks, GitNotebooksActions(), NotebookTab.OVERVIEW, onBack = {}, notes = 12) },
        "A Notebook: Sync" to { NotebookPage(notebooks.rows.first(), notebooks, GitNotebooksActions(), NotebookTab.SYNC, onBack = {}, notes = 12) },
        "A Notebook: Git" to { NotebookPage(notebooks.rows.first(), notebooks, GitNotebooksActions(), NotebookTab.GIT, onBack = {}, notes = 12) },
        "Agent Activity" to {
            AgentActivityScreen(ui = AgentActivityUi(items = emptyList()), onBack = {}, onRetry = {}, onFilter = { _, _, _ -> }, onUndo = {}, onMessageShown = {}, now = 2_000)
        },
        "Storage" to {
            StorageScreen(StorageUse(files = 12L * 1024 * 1024, webPictures = 1536, webPictureCount = 3), WebPictureSetting.WIFI_ONLY, onWebPictures = {}, onClearWebPictures = {}, onBack = {})
        },
        "GitHub" to {
            GitHubScreen(
                accounts = listOf(GitHubAccount("htxryan", primary = true)),
                signIn = SignInState.Idle,
                canSignIn = true,
                onSignIn = {},
                onCancelSignIn = {},
                onSignOut = {},
                onToken = {},
                onBack = {},
                onSendFeedback = {},
            )
        },
        "What’s New" to { WhatsNewScreen(notesView(releaseNotes, "0.2.1"), onOpenReleases = {}, onBack = {}, version = "0.2.1") },
        "Privacy" to {
            // Opened at a limit, as Search Settings opens it: Advanced shows its fields.
            val mark = remember { SettingMark().apply { request("reset-to-defaults") } }
            CompositionLocalProvider(LocalSettingMark provides mark) {
                PrivacyScreen(
                    PrivacyUi(sharing = true, counts = mapOf(EventState.WAITING to 2L, EventState.SENT to 41L), install = "5c0e8f6a000000000000000000007a96", limits = Limits.DEFAULTS),
                    PrivacyActions(),
                )
            }
        },
    )

    private val CONTROL_ROLES = setOf(Role.Button, Role.Checkbox, Role.Switch, Role.RadioButton, Role.Tab, Role.DropdownList)

    /** What on the screen now is a label: the top bar's title, every heading, every control's name. */
    private fun labels(): List<Pair<String, String>> {
        val found = ArrayList<Pair<String, String>>()
        fun visit(node: SemanticsNode, inTopBar: Boolean) {
            val config = node.config
            val topBar = inTopBar || config.getOrNull(SemanticsProperties.TestTag) == "sectionTopBar"
            if (!config.contains(SemanticsProperties.EditableText)) {
                val texts = config.getOrNull(SemanticsProperties.Text)?.map { it.text }.orEmpty().filter { it.isNotBlank() }
                val described = config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().filter { it.isNotBlank() }
                val role = config.getOrNull(SemanticsProperties.Role)
                val control = role in CONTROL_ROLES || config.contains(SemanticsActions.OnClick) || config.contains(SemanticsProperties.ToggleableState)
                when {
                    config.contains(SemanticsProperties.Heading) -> texts.forEach { found += "heading" to it }
                    control -> (texts.firstOrNull() ?: described.firstOrNull())?.let { found += (role?.toString() ?: "control") to it }
                    // The screen's title in its top bar.
                    topBar -> texts.firstOrNull()?.let { found += "title" to it }
                }
            }
            for (child in node.children) visit(child, topBar)
        }
        visit(compose.onRoot().fetchSemanticsNode(), inTopBar = false)
        return found
    }

    @Test
    fun everySettingsScreenNamesItsControlsInTitleCase() {
        var shown by mutableIntStateOf(0)
        compose.setContent { PenmossTheme { screens[shown].second() } }
        val read = ArrayList<Triple<String, String, String>>()
        for (index in screens.indices) {
            shown = index
            compose.waitForIdle()
            read += labels().map { (role, text) -> Triple(screens[index].first, role, text) }
        }
        val wrong = read.mapNotNull { (screen, role, text) -> TitleCase.problem(text)?.let { "$screen · $role: $it" } }.distinct()
        assertEquals("Labels not in Title Case:\n" + wrong.joinToString("\n"), emptyList<String>(), wrong)

        // Enough was read: every screen gave labels, and the ones this change cased are among them.
        val names = read.map { it.third }.toSet()
        for (screen in screens.map { it.first }) assertTrue("nothing read on $screen", read.any { it.first == screen })
        for (name in listOf("Load Pictures from the Web", "Commit Identity", "Wi-Fi Only", "Page Background", "Share Usage Data", "Full Width", "Advanced")) {
            assertTrue("\"$name\" was not read: ${names.sorted()}", name in names)
        }
    }
}
