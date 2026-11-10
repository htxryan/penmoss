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

    @Before
    fun open() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        deviceDb = PenmossDatabase.inMemory(context)
        journalDb = PenmossDatabase.inMemory(context)
        device = NoteStore(deviceDb)
        journal = NoteStore(journalDb)
        settings = JournalDeviceSettings(device, journal) { set ->
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
        // The Mac had set dark mode in the notebook; the phone's first pass reads it.
        notebook[SettingKeys.MODE] = JsonPrimitive("dark")
        scope.launch { settings.follow() }
        pass("h1")
        assertEquals("dark", shows { it.mode == "dark" }.settings.mode)

        // Changed on the phone: written as the same JSON value, shown at once.
        assertTrue(settings.change(mapOf(SettingKeys.THEME to JsonPrimitive("nord"), SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(17))))
        assertEquals(JsonObject(mapOf(SettingKeys.THEME to JsonPrimitive("nord"), SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(17))), written.single())
        assertEquals(JsonPrimitive("nord"), notebook[SettingKeys.THEME])
        assertEquals(JsonPrimitive(17), notebook[SettingKeys.NOTE_FONT_SIZE])
        shows { it.themeId == "nord" && it.mode == "dark" }

        // The Mac switches back to light and the system theme; the pull's pass brings it.
        notebook[SettingKeys.MODE] = JsonPrimitive("light")
        notebook.remove(SettingKeys.THEME)
        pass("h2")
        val after = shows { it.mode == "light" }.settings
        assertFalse(after.values.containsKey(SettingKeys.THEME))
        assertEquals(17, after.noteFontSize)

        // Signed out, the account's settings were cleared: the Journal's are laid there again.
        deviceDb.settings().delete("syncedSettings")
        shows { it.mode == "light" }
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

    @Test
    fun aChangeTheNotebookCannotTakeIsNotKept(): Unit = runBlocking {
        notebook[SettingKeys.MODE] = JsonPrimitive("dark")
        scope.launch { settings.follow() }
        pass("h1")
        shows { it.mode == "dark" }
        refuse = true
        assertFalse(settings.change(mapOf(SettingKeys.MODE to JsonPrimitive("light"))))
        // What the notebook holds shows again.
        assertEquals("dark", device.settingsNow().settings.mode)
        assertTrue(written.isEmpty())
    }
}
