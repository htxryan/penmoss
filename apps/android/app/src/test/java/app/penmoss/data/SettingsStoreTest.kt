package app.penmoss.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings changed on the phone (T40 P1, A411): one row per setting, laid over what the tree sent,
 * counted as unsent, and settled by what the server answers.
 */
@RunWith(AndroidJUnit4::class)
class SettingsStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val db = PenmossDatabase.inMemory(context)
    private val store = NoteStore(db)

    @After
    fun close() = db.close()

    private fun tree(hash: String, vararg settings: Pair<String, String>) =
        SyncTree(hash = hash, settings = JsonObject(settings.associate { (key, value) -> key to JsonPrimitive(value) }))

    @Test
    fun aChangeShowsAtOnceIsCountedAsUnsentAndKeepsWhatThePhoneSawFirst() = runTest {
        store.saveTree(tree("h1", SettingKeys.MODE to "light"))
        assertTrue(store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark")))
        assertTrue(store.changeSetting(SettingKeys.MODE, JsonPrimitive("system")))
        val row = db.pendingSettings().get(SettingKeys.MODE)!!
        assertEquals("\"system\"", row.value)
        assertEquals("\"light\"", row.base)
        assertEquals("system", store.observeSettings().first().settings.mode)
        // Counted with every other unsent change, so signing out keeps it (A360).
        assertEquals(1, store.unsentCount())
        assertEquals(1, store.pendingSettingsCount())
    }

    @Test
    fun aChangeMadeAgainWhileTheFirstWasSentStaysToSendBasedOnWhatWasSent() = runTest {
        store.saveTree(tree("h1"))
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark"))
        val sent = store.pendingSettings()
        // While the request is out, Ryan picks Light.
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("light"))
        store.settingsSent(sent, JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"))))
        val row = db.pendingSettings().get(SettingKeys.MODE)!!
        assertEquals("\"light\"", row.value)
        assertEquals("\"dark\"", row.base)
        assertEquals("light", store.settingsNow().settings.mode)
        // A tree that shows what was sent keeps it; one that shows something else drops it.
        store.saveTree(tree("h2", SettingKeys.MODE to "dark"))
        assertEquals(1, store.pendingSettingsCount())
        store.saveTree(tree("h3", SettingKeys.MODE to "system"))
        assertEquals(0, store.pendingSettingsCount())
        assertEquals("system", store.settingsNow().settings.mode)
    }

    @Test
    fun theCaptureDestinationChosenInSettingsIsWhereTheSheetStartsUntilSent() = runTest {
        store.saveTree(tree("h1", SettingKeys.CAPTURE to "daily"))
        store.changeSetting(SettingKeys.CAPTURE, JsonPrimitive("inbox"))
        assertEquals("inbox", store.captureDestination())
        // A tree that still says daily (sent before the change reached the server) leaves it be.
        store.saveTree(SyncTree(hash = "h2", capture = app.penmoss.engine.api.CaptureSetting("daily"), settings = tree("x", SettingKeys.CAPTURE to "daily").settings))
        assertEquals("inbox", store.captureDestination())
    }

    @Test
    fun nothingCanBeChangedBeforeTheServerHasSentAnySettings() = runTest {
        assertFalse(store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark")))
        // A tree from a server without the channel says nothing of settings.
        store.saveTree(SyncTree(hash = "h1"))
        assertFalse(store.settingsNow().known)
        assertFalse(store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark")))
        assertEquals(0, store.unsentCount())
    }

    @Test
    fun aRefusedSettingIsDroppedAndTheOthersStay() = runTest {
        store.saveTree(tree("h1"))
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark"))
        store.changeSetting(SettingKeys.TIME_ZONE, JsonPrimitive("Asia/Tokyo"))
        store.dropSettings(listOf(SettingKeys.MODE))
        assertEquals(listOf(SettingKeys.TIME_ZONE), store.pendingSettings().map { it.key })
        assertEquals("system", store.settingsNow().settings.mode)
    }

    @Test
    fun aChangeBackToTheBaseWhileOneIsOutStaysToPutTheBaseBack() = runTest {
        store.saveTree(tree("h1", SettingKeys.MODE to "system"))
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark"))
        val out = store.settingsToSend()
        // Before the server answers, System again: the server may already hold Dark.
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("system"))
        assertEquals(setOf(SettingKeys.MODE), store.settingsNow().unsent)
        store.settingsSent(out, JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"))))
        val row = db.pendingSettings().get(SettingKeys.MODE)!!
        assertEquals("\"system\"" to "\"dark\"", row.value to row.base)
        // Never sent, a change back to the base leaves nothing to send.
        store.changeSetting(SettingKeys.THEME, JsonPrimitive("nord"))
        store.changeSetting(SettingKeys.THEME, null)
        assertNull(db.pendingSettings().get(SettingKeys.THEME))
    }

    @Test
    fun aTreeShowingAValueSentWithoutAnAnswerIsThePhonesOwnChange() = runTest {
        store.saveTree(tree("h1", SettingKeys.MODE to "light"))
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("dark"))
        store.settingsToSend() // and the reply is lost
        store.changeSetting(SettingKeys.MODE, JsonPrimitive("system"))
        store.saveTree(tree("h2", SettingKeys.MODE to "dark"))
        val row = db.pendingSettings().get(SettingKeys.MODE)!!
        assertEquals("\"system\"" to "\"dark\"", row.value to row.base)
        assertNull(row.sent)
        // A 409 showing it does the same; one showing another value drops the change.
        store.changeSetting(SettingKeys.TIME_ZONE, JsonPrimitive("Asia/Tokyo"))
        store.settingsToSend()
        assertEquals(0, store.settingsOvertaken(listOf(SettingKeys.TIME_ZONE), JsonObject(mapOf(SettingKeys.TIME_ZONE to JsonPrimitive("Asia/Tokyo")))))
        assertNull(db.pendingSettings().get(SettingKeys.TIME_ZONE))
        store.settingsToSend()
        assertEquals(0, store.settingsOvertaken(listOf(SettingKeys.MODE), JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("light")))))
        assertNull(db.pendingSettings().get(SettingKeys.MODE))
    }

    @Test
    fun aRefusalDropsTheChangesAndIsShownUntilDismissed() = runTest {
        store.saveTree(tree("h1"))
        store.changeSetting(SettingKeys.DAILY_TEMPLATE, JsonPrimitive("## Plan\n"))
        store.settingsRefused(listOf(SettingKeys.DAILY_TEMPLATE), "Too large")
        val state = store.observeSettings().first()
        assertEquals(NoteStore.SettingsRefusal(listOf(SettingKeys.DAILY_TEMPLATE), "Too large"), state.refused)
        assertEquals(emptySet<String>(), state.unsent)
        store.dismissSettingsRefusal()
        assertNull(store.settingsNow().refused)
    }

    @Test
    fun aDestinationChosenInSettingsStopsWaitingCapturesChangingIt() = runTest {
        // A capture made before the server had the settings channel carries `remember` (A346).
        db.captures().insert(CaptureEntity(id = "c1", text = "Buy mulch", destination = "inbox", capturedAt = 1, remember = true))
        store.saveTree(tree("h1", SettingKeys.CAPTURE to "inbox"))
        store.changeSetting(SettingKeys.CAPTURE, JsonPrimitive("daily"))
        assertFalse(db.captures().get("c1")!!.remember)
        assertEquals(0, db.captures().rememberingCount())
    }

    /** Quick Access (T51, A946): the pinned notes in pin order, a trashed or unknown one left out, not unpinned. */
    @Test
    fun quickAccessListsThePinnedNotesInPinOrder() = runTest {
        db.notes().insert(app.penmoss.data.NoteEntity("n1", title = "Plan"))
        db.notes().insert(app.penmoss.data.NoteEntity("n2", title = "Seeds"))
        db.notes().insert(app.penmoss.data.NoteEntity("n3", title = "Old", deleted = true))
        assertEquals(emptyList<String>(), store.observeQuickAccess().first().map { it.id })
        store.saveTree(tree("h1"))
        assertTrue(store.changeSetting(SettingKeys.QUICK_ACCESS, app.penmoss.engine.settings.QuickAccess.toJson(listOf("n2", "n3", "gone", "n1"))))
        assertEquals(listOf("Seeds", "Plan"), store.observeQuickAccess().first().map { it.title })
        // Still pinned, so it comes back with the note.
        assertEquals(listOf("n2", "n3", "gone", "n1"), store.settingsNow().settings.quickAccess)
    }
}
