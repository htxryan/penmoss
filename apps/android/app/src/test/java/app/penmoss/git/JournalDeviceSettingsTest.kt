package app.penmoss.git

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.settings.QuickAccess
import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The device's settings in the Journal notebook's device map with no account (A1014): a setting
 * changed on the phone is written as `device/<key>` in the notebook with the JSON value the Mac
 * writes, and a `device/<key>` another device wrote shows on the phone after a pull. The notes
 * server's side (the route, the tree's device map, the Mac reading it) is the editor's
 * git-page test; here, the phone's Room and screens' side, the page played by [notebook].
 */
@RunWith(AndroidJUnit4::class)
class JournalDeviceSettingsTest {
    private lateinit var deviceDb: PenmossDatabase
    private lateinit var journalDb: PenmossDatabase
    private lateinit var device: NoteStore
    private lateinit var journal: NoteStore
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** The Journal notebook's WorkspaceDoc settings under `device/`, as its page keeps them. */
    private val notebook = linkedMapOf<String, JsonElement>()
    private val written = mutableListOf<JsonObject>()
    private var refuse = false

    private lateinit var settings: JournalDeviceSettings

    /** A device setting every device shares (A1137). */
    private val copyTags = "copyToNotebook.tags"

    @Before
    fun open() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        deviceDb = PenmossDatabase.inMemory(context)
        journalDb = PenmossDatabase.inMemory(context)
        device = NoteStore(deviceDb)
        journal = NoteStore(journalDb)
        settings = JournalDeviceSettings(device.settings, journal.settings) { set ->
            if (refuse) error("The notebook is opening")
            written += set
            // The page's `setSetting(doc, 'device', key, value)`; a null removes it.
            for ((key, value) in set) if (value is JsonNull) notebook.remove(key) else notebook[key] = value
            JsonObject(notebook)
        }
    }

    @After
    fun close() {
        // Wait for follow() to stop before the databases close: cancel() alone returns while its
        // Room query may still run, which then throws on the closed pool into the next runTest.
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        deviceDb.close()
        journalDb.close()
    }

    /** The Journal's next pass after a pull: its tree with the device map as the notebook holds it. */
    private suspend fun pass(hash: String) = journal.saveTree(SyncTree(hash = hash, device = JsonObject(notebook)))

    private suspend fun shows(check: (app.penmoss.engine.settings.Settings) -> Boolean) = withTimeout(5_000) {
        device.observeSettings().first { it.known && check(it.settings) }
    }

    @Test
    fun aSettingChangedOnThePhoneIsTheNotebooksDeviceKeyAndTheMacsShowsAfterAPull(): Unit = runBlocking {
        // The Mac had set Copy Tags off in the notebook; the phone's first pass reads it.
        notebook[copyTags] = JsonPrimitive(false)
        scope.launch { settings.follow() }
        pass("h1")
        shows { it.values[copyTags] == JsonPrimitive(false) }

        // Changed on the phone: written as the same JSON value, shown at once.
        val symbols = JsonArray(listOf(JsonPrimitive("→")))
        assertTrue(settings.change(mapOf(SettingKeys.SYMBOLS to symbols)))
        assertEquals(JsonObject(mapOf(SettingKeys.SYMBOLS to symbols)), written.single())
        assertEquals(symbols, notebook[SettingKeys.SYMBOLS])
        shows { it.values[SettingKeys.SYMBOLS] == symbols }

        // The Mac turns Copy Tags back on; the pull's pass brings it.
        notebook[copyTags] = JsonPrimitive(true)
        pass("h2")
        shows { it.values[copyTags] == JsonPrimitive(true) }

        // Signed out, the account's settings were cleared: the Journal's are laid there again.
        deviceDb.settings().delete("syncedSettings")
        shows { it.values[copyTags] == JsonPrimitive(true) }
    }

    /**
     * The look and layout stay on the phone (A1626): the notebook's value shows until the phone
     * picks its own, which is never written to the notebook, and another device's later change
     * there no longer reaches it.
     */
    @Test
    fun theLookIsThisPhonesOwnAndNeverInTheNotebook(): Unit = runBlocking {
        notebook[SettingKeys.MODE] = JsonPrimitive("dark")
        notebook[SettingKeys.THEME] = JsonPrimitive("slate")
        scope.launch { settings.follow() }
        pass("h1")
        shows { it.mode == "dark" && it.themeId == "slate" }

        assertTrue(settings.change(mapOf(SettingKeys.MODE to JsonPrimitive("light"), SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(17))))
        assertTrue(settings.change(mapOf(SettingKeys.THEME to null)))
        assertTrue(written.isEmpty())
        assertEquals(JsonPrimitive("dark"), notebook[SettingKeys.MODE])
        assertEquals(JsonPrimitive("slate"), notebook[SettingKeys.THEME])
        val shown = shows { it.mode == "light" && it.noteFontSize == 17 && !it.values.containsKey(SettingKeys.THEME) }.settings
        assertEquals("light", shown.mode)

        // Another device changes the mode and the theme in the notebook: the phone keeps its own.
        notebook[SettingKeys.MODE] = JsonPrimitive("system")
        notebook[SettingKeys.THEME] = JsonPrimitive("nord")
        pass("h2")
        // A later pass's own change (Copy Tags) shows, the look as the phone left it.
        notebook[copyTags] = JsonPrimitive(false)
        pass("h3")
        val after = shows { it.values[copyTags] == JsonPrimitive(false) }.settings
        assertEquals("light", after.mode)
        assertFalse(after.values.containsKey(SettingKeys.THEME))
        assertEquals(17, after.noteFontSize)
    }

    /** A note size the Mac saved in the notebook is the Mac's: the phone shows its own default, else its own pick (A1628). */
    @Test
    fun theNoteSizeIsNeverTheMacs(): Unit = runBlocking {
        notebook[SettingKeys.NOTE_FONT_SIZE] = JsonPrimitive(16)
        notebook[copyTags] = JsonPrimitive(false)
        scope.launch { settings.follow() }
        pass("h1")
        val first = shows { it.values[copyTags] == JsonPrimitive(false) }.settings
        assertEquals(app.penmoss.engine.settings.FontSettings.PHONE_SIZE_DEFAULT, first.noteFontSize)

        assertTrue(settings.change(mapOf(SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(20))))
        assertEquals(20, shows { it.noteFontSize == 20 }.settings.noteFontSize)
        assertEquals(JsonPrimitive(16), notebook[SettingKeys.NOTE_FONT_SIZE])
    }

    @Test
    fun quickAccessPinsAndUnpinsInTheNotebook(): Unit = runBlocking {
        scope.launch { settings.follow() }
        pass("h1")
        shows { true }
        val note = "01JBGITN0TE00000000000000A"
        val other = "01JBGITN0TE00000000000000B"
        for (id in listOf(note, other)) {
            val pins = QuickAccess.toggled(device.settingsNow().settings.quickAccess, id)!!
            assertTrue(settings.change(mapOf(SettingKeys.QUICK_ACCESS to QuickAccess.toJson(pins))))
        }
        assertEquals(JsonArray(listOf(JsonPrimitive(note), JsonPrimitive(other))), notebook[SettingKeys.QUICK_ACCESS])
        assertEquals(listOf(note, other), shows { it.quickAccess.size == 2 }.settings.quickAccess)

        // Unpinned on the phone: gone from the notebook too.
        val unpinned = QuickAccess.toggled(device.settingsNow().settings.quickAccess, note)!!
        settings.change(mapOf(SettingKeys.QUICK_ACCESS to QuickAccess.toJson(unpinned)))
        assertEquals(JsonArray(listOf(JsonPrimitive(other))), notebook[SettingKeys.QUICK_ACCESS])
        assertEquals(listOf(other), shows { it.quickAccess == listOf(other) }.settings.quickAccess)

        // The Mac pins one; the phone has it after the pull.
        notebook[SettingKeys.QUICK_ACCESS] = JsonArray(listOf(JsonPrimitive(other), JsonPrimitive(note)))
        pass("h2")
        assertEquals(listOf(other, note), shows { it.quickAccess.size == 2 }.settings.quickAccess)
    }

    /**
     * A custom theme made, edited and deleted on the phone (T40 P1b, A417), as Settings →
     * Appearance and the theme editor change it: each a device key in the notebook, written
     * whole, with no queue and no merge (the Mac writes them the same way).
     */
    @Test
    fun aCustomThemeIsMadeChosenEditedAndDeletedInTheNotebook(): Unit = runBlocking {
        scope.launch { settings.follow() }
        pass("h1")
        shows { true }
        val catalogue = app.penmoss.engine.settings.ThemeCatalogue.bundled
        val copy = app.penmoss.engine.settings.ThemeEdits.duplicate(catalogue.builtIn("nord")!!, "custom-abc", "Nord copy", catalogue)
        val key = app.penmoss.engine.settings.ThemeEdits.key("custom-abc")
        assertTrue(settings.change(mapOf(key to copy, SettingKeys.THEME to JsonPrimitive("custom-abc"))))
        assertEquals(copy, notebook[key])
        // The theme itself is in the notebook for every device; choosing it is this phone's (A1626).
        assertFalse(notebook.containsKey(SettingKeys.THEME))
        assertEquals("custom-abc", catalogue.resolve(shows { it.themeId == "custom-abc" }.settings).id)

        val renamed = app.penmoss.engine.settings.ThemeEdits.withName(copy, "Night")
        assertTrue(settings.change(mapOf(key to renamed)))
        assertEquals(renamed, notebook[key])
        shows { it.customThemes.any { theme -> (theme["name"] as? JsonPrimitive)?.content == "Night" } }

        val deletion = app.penmoss.engine.settings.ThemeEdits.deletion(renamed, catalogue)
        assertTrue(settings.change(mapOf(key to deletion, SettingKeys.THEME to deletion["base"])))
        assertEquals(deletion, notebook[key])
        assertFalse(notebook.containsKey(SettingKeys.THEME))
        // Shown once both have landed: a pass in between may briefly show the map from before.
        shows { it.themeId == "nord" && it.customThemes.none { theme -> (theme["id"] as? JsonPrimitive)?.content == "custom-abc" } }
    }

    @Test
    fun aChangeTheNotebookCannotTakeIsNotKept(): Unit = runBlocking {
        notebook[copyTags] = JsonPrimitive(false)
        scope.launch { settings.follow() }
        pass("h1")
        shows { it.values[copyTags] == JsonPrimitive(false) }
        refuse = true
        assertFalse(settings.change(mapOf(copyTags to JsonPrimitive(true))))
        // What the notebook holds shows again.
        assertEquals(JsonPrimitive(false), device.settingsNow().settings.values[copyTags])
        assertTrue(written.isEmpty())
    }
}
