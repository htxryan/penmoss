package app.penmoss.ui.keys

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.keys.ShortcutCatalogue
import app.penmoss.ui.DeepLinkInbox
import app.penmoss.ui.RecentSwitch
import app.penmoss.ui.RecentSwitcherKeys
import android.view.KeyEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The keyboard's parity guard (T40 P9, PL9, A497): every command the web has is given its place
 * on Android, and every one the app says it runs is registered by a screen and does what that
 * screen's button does.
 */
@RunWith(AndroidJUnit4::class)
class AndroidCommandsTest {
    @get:Rule
    val compose = createComposeRule()

    private val catalogue = ShortcutCatalogue.bundled
    private val inbox = DeepLinkInbox()

    @Test
    fun everyWebCommandHasItsPlaceOnAndroid() {
        val missing = catalogue.commands.filter { AndroidCommands.coverage(it.id, it.scope) == null }.map { it.id }
        assertEquals("Commands with no Android coverage: give each a Coverage in AndroidCommands", emptyList<String>(), missing)
        val stale = AndroidCommands.app.keys.filter { catalogue.command(it) == null }
        assertEquals("Coverage for commands the web no longer has", emptyList<String>(), stale)
        // Every command the page runs is an editor command (the page dispatches only those, A493).
        for (command in catalogue.commands.filter { AndroidCommands.coverage(it.id, it.scope) == Coverage.Page }) {
            assertEquals(command.id, "editor", command.scope)
        }
    }

    private fun rootActions(ran: MutableList<String>) = RootActions(
        open = { ran += "open:$it" },
        home = { ran += "home" },
        search = { ran += "search" },
        palette = { ran += "palette" },
        today = { ran += "today" },
        thisWeek = { ran += "week" },
        newNote = { ran += "new" },
        newFolder = { ran += "folder" },
        sort = { ran += "sort:$it" },
        capture = { ran += "capture" },
        toggleDark = { ran += "dark" },
        toggleFullWidth = { ran += "wide" },
        graph = { ran += "graph" },
        feedback = { ran += "feedback" },
    )

    private fun noteActions(ran: MutableList<String>) = NoteActions(
        trash = { ran += "trash" },
        move = { ran += "move" },
        history = { ran += "history" },
        saveVersion = { ran += "version" },
        tags = { ran += "tags" },
        openPeriodic = { kind, date -> ran += "${kind.wire}:$date" },
        copyMarkdown = { ran += "copy markdown" },
        copyRich = { ran += "copy rich" },
        toggleSource = { ran += "source" },
        info = { ran += "info" },
        localGraph = { ran += "local graph" },
        comments = { ran += "comments" },
        pinQuickAccess = { ran += "pin" },
        copyAgentReference = { ran += "agent reference" },
        addNoteComment = { ran += "note comment" },
    )

    private val nav = FromEditor.PeriodicNavData(
        ToEditor.PeriodKind.DAILY,
        "2026-10-21",
        "Wednesday 21 October 2026",
        FromEditor.NavTarget("2026-10-20", "2026-10-20", "Tuesday 20 October 2026", "2026-10-20"),
        FromEditor.NavTarget("2026-10-22", "2026-10-22", "Thursday 22 October 2026", "2026-10-22"),
        FromEditor.NavTarget("2026-10-19", "Week 2026-W43", "Week of Monday 19 October 2026", "2026-W43"),
        null,
    )

    private val switch = RecentSwitch()

    @Test
    fun noCommandIsLeftForALaterSlice() {
        // The final parity pass (after T40 P6): every web command runs here, or says why not.
        // The last one planned, Settings → Git notebooks, came with T50 G7 (#155).
        val later = AndroidCommands.app.filterValues { it is Coverage.Later }.keys
        assertEquals(emptySet<String>(), later)
        assertEquals(Coverage.Native("every screen"), AndroidCommands.app["app.gitNotebooks"])
        // Its screen is a route every screen opens.
        val routes = CommandRoutes::class.java.declaredFields.mapNotNull { runCatching { it.get(null) as? String }.getOrNull() }
        assertEquals(listOf("settings/git"), routes.filter { "git" in it })
    }

    @Test
    fun everyCommandAndroidRunsIsRegisteredByItsScreens() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalAppCommands provides commands) {
                RootCommands(rootActions(ran), inbox)
                NoteCommandSet(ready = true, editable = true, nav = nav, focusTitle = { ran += "title" }, actions = noteActions(ran))
                RecentSwitcherKeys(switch, count = { 3 }) { ran += "recent:$it" }
                TaggedCommands(clear = { ran += "all notes" })
            }
        }
        compose.waitForIdle()
        val native = AndroidCommands.app.filterValues { it is Coverage.Native }.keys
        // A folder row's own keys are its row's, in Reorder mode (FolderScreens' ReorderRow).
        val rows = setOf("folder.moveUp", "folder.moveDown")
        assertEquals((native - rows).sorted(), commands.availableIds().filter { it in native }.sorted())
        val unexpected = commands.availableIds().filter { AndroidCommands.app[it] !is Coverage.Native }
        assertEquals("Registered but not listed as Native", emptyList<String>(), unexpected)
    }

    @Test
    fun aCommandDoesWhatItsScreensButtonDoes() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalAppCommands provides commands) {
                RootCommands(rootActions(ran), inbox)
                NoteCommandSet(ready = true, editable = true, nav = nav, focusTitle = { ran += "title" }, actions = noteActions(ran))
                RecentSwitcherKeys(switch, count = { 3 }) { ran += "recent:$it" }
                TaggedCommands(clear = { ran += "all notes" })
            }
        }
        compose.waitForIdle()
        val expected = linkedMapOf(
            "app.palette" to "palette",
            "app.quickOpen" to "search",
            "app.search" to "search",
            "app.cheatsheet" to "open:settings/shortcuts",
            "app.shortcuts" to "open:settings/shortcuts",
            "app.settings" to "open:settings",
            "app.sendFeedback" to "feedback",
            "app.appearance" to "open:settings/appearance",
            "app.display" to "open:settings/display",
            "app.symbols" to "open:settings/symbols",
            "theme.switch" to "open:settings/appearance",
            "journal.settings" to "open:settings/daily",
            "journal.calendar" to "open:journal",
            "app.trash" to "open:trash",
            "app.home" to "home",
            "journal.today" to "today",
            "journal.thisWeek" to "week",
            "note.new" to "new",
            "folder.new" to "folder",
            "folder.sortManual" to "sort:manual",
            "folder.sortAlpha" to "sort:alpha",
            "folder.sortModified" to "sort:modified",
            "app.capture" to "capture",
            "theme.toggleDark" to "dark",
            "note.fullWidth" to "wide",
            "app.graph" to "graph",
            "note.copyMarkdown" to "copy markdown",
            "note.copyRich" to "copy rich",
            "note.toggleSource" to "source",
            "note.backlinks" to "info",
            "note.localGraph" to "local graph",
            "note.comments" to "comments",
            "note.copyAgentReference" to "agent reference",
            "note.addNoteComment" to "note comment",
            "note.delete" to "trash",
            "note.move" to "move",
            "note.history" to "history",
            "note.saveVersion" to "version",
            "note.addTag" to "tags",
            "note.focusTitle" to "title",
            "journal.previous" to "daily:2026-10-20",
            "journal.next" to "daily:2026-10-22",
            "journal.week" to "weekly:2026-10-19",
            "tags.clearFilter" to "all notes",
        )
        for ((id, outcome) in expected) {
            ran.clear()
            compose.runOnIdle { assertTrue(id, commands.run(id)) }
            assertEquals(id, listOf(outcome), ran)
        }
        // The recent-notes switcher opens, as Home's Recent does, on the note after the open one.
        ran.clear()
        compose.runOnIdle { assertTrue(commands.run("app.recent")) }
        assertTrue(switch.open)
        assertEquals(1, switch.index)
        assertEquals(emptyList<String>(), ran)
    }

    private fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN, ctrl: Boolean = true, shift: Boolean = false, repeat: Int = 0): KeyEvent {
        var meta = 0
        if (ctrl) meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (shift) meta = meta or KeyEvent.META_SHIFT_ON
        return KeyEvent(0L, 0L, action, code, repeat, meta)
    }

    private fun switcher(commands: AppCommands, ran: MutableList<String>) {
        compose.setContent {
            CompositionLocalProvider(LocalAppCommands provides commands) {
                RootCommands(rootActions(ran), inbox)
                RecentSwitcherKeys(switch, count = { 4 }) { ran += "recent:$it" }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun ctrlEOpensTheSwitcherEvenInANoteAndLettingGoOfCtrlOpensTheNoteChosen() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        switcher(commands, ran)
        compose.runOnIdle {
            // In a note too, ahead of the page (A494): the switcher needs Ctrl's release.
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E), inEditor = true))
            assertTrue(switch.open)
            assertTrue(switch.held)
            // A held E moves once (review S11); E again moves on; Shift+E back.
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E, repeat = 1), inEditor = true))
            assertEquals(1, switch.index)
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E, KeyEvent.ACTION_UP), inEditor = true))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E), inEditor = true))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E, shift = true), inEditor = true))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_E), inEditor = true))
            assertEquals(2, switch.index)
            // Every other key is the switcher's while it is open: none reaches the note.
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_A, ctrl = false), inEditor = true))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.ACTION_UP, ctrl = false), inEditor = true))
            assertFalse(switch.open)
        }
        assertEquals(listOf("recent:2"), ran)
        // Closed, it takes nothing: a note's keys are its page's again.
        compose.runOnIdle { assertFalse(commands.handle(key(KeyEvent.KEYCODE_A, ctrl = false), inEditor = true)) }
    }

    @Test
    fun theSwitcherFollowsTheKeysTheUserBoundToIt() {
        val commands = AppCommands()
        commands.follow(JsonObject(mapOf("keys.app.recent" to JsonArray(listOf(JsonPrimitive("Mod+J"))))))
        val ran = mutableListOf<String>()
        switcher(commands, ran)
        compose.runOnIdle {
            assertFalse(commands.handle(key(KeyEvent.KEYCODE_E), inEditor = true))
            assertFalse(switch.open)
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_J), inEditor = false))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_J), inEditor = false))
            assertEquals(2, switch.index)
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_CTRL_RIGHT, KeyEvent.ACTION_UP, ctrl = false), inEditor = false))
        }
        assertEquals(listOf("recent:2"), ran)
    }

    @Test
    fun theSwitcherNeverTakesAKeyThatTypesOrThatAndroidKeeps() {
        // Review S3 (A556): bound on the web to Alt+E, which types on these layouts, or to a
        // combination Android keeps, the switcher stays closed and the key goes on, as for any command.
        val generic = AppCommands(chars = Layout.GENERIC)
        generic.follow(JsonObject(mapOf("keys.app.recent" to JsonArray(listOf(JsonPrimitive("Alt+E"), JsonPrimitive("Mod+Left"))))))
        val ran = mutableListOf<String>()
        switcher(generic, ran)
        compose.runOnIdle {
            // Alt+E is the acute dead key on Generic: é, in a note too.
            assertFalse(generic.handle(alt(KeyEvent.KEYCODE_E), inEditor = true))
            assertFalse(generic.handle(alt(KeyEvent.KEYCODE_E), inEditor = false))
            // Ctrl+← moves a word in a text field.
            assertFalse(generic.handle(key(KeyEvent.KEYCODE_DPAD_LEFT), inEditor = false))
            assertFalse(switch.open)
        }
        assertEquals(emptyList<String>(), ran)
    }

    @Test
    fun onAPolishLayoutAltGrETypesAndTheLeftAltOpensTheSwitcher() {
        val polish = AppCommands(chars = Layout.POLISH)
        polish.follow(JsonObject(mapOf("keys.app.recent" to JsonArray(listOf(JsonPrimitive("Alt+E"))))))
        switcher(polish, mutableListOf())
        compose.runOnIdle {
            assertFalse(polish.handle(alt(KeyEvent.KEYCODE_E, right = true), inEditor = false))
            assertFalse(switch.open)
            assertTrue(polish.handle(alt(KeyEvent.KEYCODE_E), inEditor = false))
            assertTrue(switch.open)
            // Open, it takes every key: AltGr+E moves on, as E did with its modifier held.
            assertTrue(polish.handle(alt(KeyEvent.KEYCODE_E, right = true), inEditor = false))
            assertEquals(2, switch.index)
        }
    }

    private fun alt(code: Int, right: Boolean = false): KeyEvent =
        KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, code, 0, KeyEvent.META_ALT_ON or if (right) KeyEvent.META_ALT_RIGHT_ON else KeyEvent.META_ALT_LEFT_ON)

    @Test
    fun theSwitcherOpenedByItsCommandWaitsForEnter() {
        // From Search's actions, or the page (no Ctrl held): as the web's palette opens it.
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        switcher(commands, ran)
        compose.runOnIdle {
            assertTrue(commands.run("app.recent"))
            assertFalse(switch.held)
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.ACTION_UP, ctrl = false), inEditor = false))
            assertTrue(switch.open)
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_DPAD_DOWN, ctrl = false), inEditor = false))
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_ENTER, ctrl = false), inEditor = false))
        }
        assertEquals(listOf("recent:2"), ran)
    }

    @Test
    fun ctrlKOpensSearchsActionsOutsideANoteAndLinksTextInOne() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        switcher(commands, ran)
        compose.runOnIdle {
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_K), inEditor = false))
            // In a note the page has it: the editor's Link (A42), as on the web.
            assertFalse(commands.handle(key(KeyEvent.KEYCODE_K), inEditor = true))
            // Ctrl+Shift+K is Quick capture's, not the palette's.
            assertTrue(commands.handle(key(KeyEvent.KEYCODE_K, shift = true), inEditor = false))
        }
        assertEquals(listOf("palette", "capture"), ran)
    }

    @Test
    fun aNotesCommandsWaitUntilItIsOpenAndAFolderFilesInItself() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalAppCommands provides commands) {
                RootCommands(rootActions(ran), inbox)
                NoteCommandSet(ready = false, editable = false, nav = null, focusTitle = { ran += "title" }, actions = noteActions(ran))
                FolderCommands(newNote = { ran += "new here" }, newFolder = { ran += "folder here" }, sort = { ran += "sort here:$it" })
            }
        }
        compose.waitForIdle()
        compose.runOnIdle {
            for (id in listOf("note.delete", "note.focusTitle", "journal.previous", "journal.week")) {
                assertTrue(id, !commands.run(id))
            }
            commands.dispatch("Alt+N")
            commands.dispatch("Alt+Shift+N")
            commands.run("folder.sortAlpha")
        }
        assertEquals(listOf("new here", "folder here", "sort here:alpha"), ran)
    }

    @Test
    fun aLauncherShortcutRunsOnceTheScreensAreUp() {
        val commands = AppCommands()
        val ran = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalAppCommands provides commands) { RootCommands(rootActions(ran), inbox) }
        }
        inbox.offer(LauncherAction.Today)
        compose.waitUntil(5_000) { "today" in ran }
        inbox.offer(LauncherAction.Search)
        compose.waitUntil(5_000) { "search" in ran }
        assertEquals(listOf("today", "search"), ran)
        assertEquals(null, inbox.action.value)
        // A note's shortcut is a link's: it waits in the inbox's note for the screens that open notes.
        inbox.offer("01JD2Z7Q8R4T6Y8W0E2R4T6YB1")
        compose.waitForIdle()
        assertEquals("01JD2Z7Q8R4T6Y8W0E2R4T6YB1", inbox.note.value)
        assertEquals(listOf("today", "search"), ran)
    }
}
