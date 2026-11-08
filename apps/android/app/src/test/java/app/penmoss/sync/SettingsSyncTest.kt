package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.capture.Captures
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.engine.settings.string
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The settings channel end to end (T40 P1, A410, A411): the app's real coordinator, engine, Room
 * store and HTTP client against a small fake Penmoss. A setting changed in airplane mode shows at
 * once and reaches the server on the first pass that can; one changed on the web meanwhile wins.
 */
@RunWith(AndroidJUnit4::class)
class SettingsSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()

    /** Airplane mode: every request fails before it leaves the phone. */
    @Volatile
    private var online = true

    /**
     * The next `PUT /api/settings` reaches the server and is applied, but its reply is lost and
     * the phone goes into airplane mode at that moment.
     */
    @Volatile
    private var loseSettingsReply = false

    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var sync: SyncCoordinator
    private lateinit var work: PassWork
    private lateinit var captures: Captures

    @Before
    fun setUp() {
        server.dispatcher = penmoss
        server.start()
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                if (!online) throw IOException("airplane mode")
                val response = chain.proceed(chain.request())
                if (loseSettingsReply && chain.request().url.encodedPath == "/api/settings") {
                    response.close()
                    loseSettingsReply = false
                    online = false
                    throw IOException("reply lost")
                }
                response
            }
            .build()
        val api = HttpPenmossApi(server.url("/").toString(), http)
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        val attachments = Attachments(db.attachments(), folder.newFolder("a"), folder.newFolder("c"), api)
        captures = Captures(db.captures(), store, attachments, api)
        work = PassWork(store, attachments, NoteFiler(store, api), OpenEditors(), captures = captures, settings = SettingsSender(store, api))
        lateinit var engine: SyncEngine
        sync = SyncCoordinator(
            scope,
            engine = { engine },
            beforePass = work::beforePass,
            afterPass = work::afterPass,
            beforeNote = work::beforeNote,
        )
        engine = SyncEngine(api, store) { sync.publish(it) }
    }

    @After
    fun tearDown() {
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
        server.close()
    }

    private fun pass(): PassOutcome = runBlocking { sync.backgroundPass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) }

    private fun shown() = runBlocking { store.settingsNow() }

    private fun change(key: String, value: Any?) = runBlocking {
        store.changeSetting(key, when (value) {
            null -> null
            is Boolean -> JsonPrimitive(value)
            else -> JsonPrimitive(value.toString())
        })
    }

    @Test
    fun aSettingChangedOfflineShowsAtOnceAndIsSentOnTheFirstPassOnline() {
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(shown().known)

        // Airplane mode: Ryan picks Nord and Dark on the phone.
        online = false
        assertTrue(change(SettingKeys.THEME, "nord"))
        assertTrue(change(SettingKeys.MODE, "dark"))
        assertTrue(change(SettingKeys.FULL_WIDTH, true))
        val offline = shown()
        assertEquals("nord", offline.settings.themeId)
        assertEquals("dark", offline.settings.mode)
        assertTrue(offline.settings.fullWidth)
        assertEquals(setOf(SettingKeys.THEME, SettingKeys.MODE, SettingKeys.FULL_WIDTH), offline.unsent)
        // The theme it resolves to is Nord, from the colours the app ships, before the server knows.
        assertEquals("nord", ThemeCatalogue.bundled.resolve(offline.settings).id)
        assertEquals(PassOutcome.FAILED, pass())
        assertTrue(penmoss.settingsChanges.isEmpty())
        assertEquals(3, runBlocking { store.unsentCount() })

        // Back online: one pass sends all three with what the phone saw before, and the web has them.
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        val sent = penmoss.settingsChanges.single()
        assertEquals("dark", sent.getJSONObject("set").getString(SettingKeys.MODE))
        assertTrue(sent.getJSONObject("base").isNull(SettingKeys.MODE))
        assertEquals(mapOf(SettingKeys.THEME to "nord", SettingKeys.MODE to "dark", SettingKeys.FULL_WIDTH to true), penmoss.settings.toMap())
        val after = shown()
        assertEquals(emptySet<String>(), after.unsent)
        assertEquals("nord", after.settings.themeId)
        assertEquals(0, runBlocking { store.unsentCount() })
    }

    /**
     * #141 (A810): on the web a change made before the device had the server's settings could lose
     * to the setting's older history in the Yjs map. The phone never merges a map: it sends each
     * change with the value it last saw, and the server takes it while the setting still has that
     * value, whatever its history. A change made at launch, before the first pass, goes.
     */
    @Test
    fun aChangeMadeAtLaunchBeforeTheFirstPassWinsOverTheSettingsOlderHistory() {
        // The setting's history on the web: Light, Dark, then System; a template set, then changed.
        penmoss.setOnWeb(SettingKeys.MODE, "light")
        penmoss.setOnWeb(SettingKeys.MODE, "dark")
        penmoss.setOnWeb(SettingKeys.MODE, "system")
        penmoss.setOnWeb(SettingKeys.DAILY_TEMPLATE, "## Old\n")
        penmoss.setOnWeb(SettingKeys.DAILY_TEMPLATE, "## Mine\n")
        assertEquals(PassOutcome.SYNCED, pass())

        // The app starts again: before its first pass, Ryan picks Light and resets the template.
        assertTrue(change(SettingKeys.MODE, "light"))
        assertTrue(change(SettingKeys.DAILY_TEMPLATE, null))
        assertEquals("light", shown().settings.mode)

        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("light", penmoss.settings[SettingKeys.MODE])
        assertFalse(penmoss.settings.containsKey(SettingKeys.DAILY_TEMPLATE))
        val after = shown()
        assertEquals("light", after.settings.mode)
        assertNull(after.settings.template(SettingKeys.DAILY_TEMPLATE))
        assertEquals(emptySet<String>(), after.unsent)
    }

    @Test
    fun aSettingChangedOnTheWebMeanwhileWinsAndTheRestStillGo() {
        penmoss.setOnWeb(SettingKeys.MODE, "system")
        assertEquals(PassOutcome.SYNCED, pass())

        online = false
        change(SettingKeys.MODE, "dark")
        change(SettingKeys.TIME_ZONE, "Asia/Tokyo")
        // On the Mac, meanwhile: Light. The phone has not seen it.
        penmoss.setOnWeb(SettingKeys.MODE, "light")

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // The first try was refused for the mode alone; the time zone went on its own.
        assertEquals(2, penmoss.settingsChanges.size)
        assertFalse(penmoss.settingsChanges.last().getJSONObject("set").has(SettingKeys.MODE))
        assertEquals("light", penmoss.settings[SettingKeys.MODE])
        assertEquals("Asia/Tokyo", penmoss.settings[SettingKeys.TIME_ZONE])
        val after = shown()
        assertEquals("light", after.settings.mode)
        assertEquals("Asia/Tokyo", after.settings.timeZone)
        assertEquals(emptySet<String>(), after.unsent)
    }

    @Test
    fun aTreeThatShowsTheSettingChangedElsewhereDropsTheChangeBeforeItIsSent() {
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.CAPTURE, "inbox")
        // On the web, meanwhile: Today's note. The settings route is failing, so the phone's change
        // is not sent this pass, but the tree comes and shows the web's choice: the change is dropped.
        penmoss.setOnWeb(SettingKeys.CAPTURE, "daily")
        penmoss.settingsDown = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.settingsChanges.size)
        assertEquals(emptySet<String>(), shown().unsent)
        assertEquals("daily", shown().settings.captureDestination)
        assertEquals("daily", runBlocking { store.captureDestination() })
        // Nothing is left to send once the route is back.
        penmoss.settingsDown = false
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.settingsChanges.size)
    }

    @Test
    fun changingASettingBackToWhatTheServerHasLeavesNothingToSend() {
        penmoss.setOnWeb(SettingKeys.MODE, "light")
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.MODE, "dark")
        change(SettingKeys.MODE, "system")
        // Still based on Light, which the phone saw before the first change.
        assertEquals("system", shown().settings.mode)
        change(SettingKeys.MODE, "light")
        assertEquals(emptySet<String>(), shown().unsent)
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.settingsChanges.isEmpty())
    }

    @Test
    fun aResetSendsTheSettingAsRemoved() {
        penmoss.setOnWeb(SettingKeys.DAILY_TEMPLATE, "## Mine\n")
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("## Mine\n", shown().settings.template(SettingKeys.DAILY_TEMPLATE))
        change(SettingKeys.DAILY_TEMPLATE, null)
        assertEquals(null, shown().settings.template(SettingKeys.DAILY_TEMPLATE))
        assertEquals(PassOutcome.SYNCED, pass())
        val sent = penmoss.settingsChanges.single()
        assertTrue(sent.getJSONObject("set").isNull(SettingKeys.DAILY_TEMPLATE))
        assertEquals("## Mine\n", sent.getJSONObject("base").getString(SettingKeys.DAILY_TEMPLATE))
        assertFalse(penmoss.settings.containsKey(SettingKeys.DAILY_TEMPLATE))
    }

    @Test
    fun aServerWithoutTheSettingsChannelTakesNoChangesAndNothingIsLost() {
        penmoss.settingsChannel = false
        assertEquals(PassOutcome.SYNCED, pass())
        assertFalse(shown().known)
        assertFalse(change(SettingKeys.MODE, "dark"))
        assertEquals(0, runBlocking { store.unsentCount() })
    }

    @Test
    fun aChoiceMadeBackToWhatTheServerHadWhileTheChangeIsOutStillWins() {
        penmoss.setOnWeb(SettingKeys.MODE, "system")
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.MODE, "dark")
        // While Dark is with the server, Ryan taps System again: what the phone saw before.
        penmoss.whileSettingsOut = {
            penmoss.whileSettingsOut = null
            change(SettingKeys.MODE, "system")
        }
        assertEquals(PassOutcome.SYNCED, pass())
        // Dark landed, so System goes next, based on it, and the phone settles on System.
        assertEquals(listOf("dark", "system"), penmoss.settingsChanges.map { it.getJSONObject("set").getString(SettingKeys.MODE) })
        assertEquals("dark", penmoss.settingsChanges.last().getJSONObject("base").getString(SettingKeys.MODE))
        assertEquals("system", penmoss.settings[SettingKeys.MODE])
        assertEquals("system", shown().settings.mode)
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun aChangeMadeAfterALostReplyIsNotTakenForOneMadeElsewhere() {
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.MODE, "dark")
        // Dark reaches the server, but the reply is lost as the phone goes offline.
        loseSettingsReply = true
        assertEquals(PassOutcome.FAILED, pass())
        assertEquals("dark", penmoss.settings[SettingKeys.MODE])
        // Offline, Ryan picks Light. The server holds Dark, which this phone sent itself.
        change(SettingKeys.MODE, "light")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("light", penmoss.settings[SettingKeys.MODE])
        assertEquals("light", shown().settings.mode)
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun aTreeShowingTheValueOfALostReplyKeepsTheChangeMadeSince() {
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.TIME_ZONE, "Asia/Tokyo")
        loseSettingsReply = true
        assertEquals(PassOutcome.FAILED, pass())
        change(SettingKeys.TIME_ZONE, "Europe/London")
        // The settings route is busy: the tree comes first and shows Tokyo, this phone's own.
        online = true
        penmoss.settingsDown = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("Europe/London", shown().settings.timeZone)
        assertEquals(setOf(SettingKeys.TIME_ZONE), shown().unsent)
        penmoss.settingsDown = false
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("Europe/London", penmoss.settings[SettingKeys.TIME_ZONE])
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun aChangeTheServerWillNotTakeIsDroppedAndSettingsSaysWhy() {
        assertEquals(PassOutcome.SYNCED, pass())
        change(SettingKeys.DAILY_TEMPLATE, "## Plan\n")
        val tooLarge = JSONObject().put("error", JSONObject().put("code", "too_large").put("message", "The request body is too large"))
        penmoss.refuseSettings = 413 to tooLarge
        assertEquals(PassOutcome.SYNCED, pass())
        val refused = shown().refused!!
        assertEquals(listOf(SettingKeys.DAILY_TEMPLATE), refused.keys)
        assertEquals("The request body is too large", refused.message)
        assertEquals(emptySet<String>(), shown().unsent)
        // Not sent again for ever.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.settingsChanges.size)
        runBlocking { store.dismissSettingsRefusal() }
        assertNull(shown().refused)

        // A 400 naming one setting drops that one, says so, and the others still go.
        change(SettingKeys.TIME_ZONE, "Asia/Tokyo")
        change(SettingKeys.MODE, "dark")
        val invalid = JSONObject().put(
            "error",
            JSONObject().put("code", "invalid_setting").put("message", "timeZone must be an IANA time zone").put("keys", JSONArray(listOf(SettingKeys.TIME_ZONE))),
        )
        penmoss.refuseSettings = 400 to invalid
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf(SettingKeys.TIME_ZONE), shown().refused!!.keys)
        assertEquals("dark", penmoss.settings[SettingKeys.MODE])
        assertFalse(penmoss.settings.containsKey(SettingKeys.TIME_ZONE))
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun aCaptureToTheOtherDestinationNeverChangesTheSetting() {
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        // Settings → Quick Capture → New Note in Inbox, offline.
        change(SettingKeys.CAPTURE, CaptureRequest.INBOX)
        // The capture sheet, still offline: one capture to Today's Note, the other destination.
        runBlocking { captures.save("Buy mulch", emptyList(), CaptureRequest.DAILY) }
        // A947 (T51): the capture's choice is that capture's only; the setting stays the Inbox.
        assertEquals(CaptureRequest.INBOX, shown().settings.captureDestination)
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.captures.size)
        assertEquals(CaptureRequest.INBOX, penmoss.settings[SettingKeys.CAPTURE])
        assertEquals(CaptureRequest.INBOX, shown().settings.captureDestination)
        assertEquals(CaptureRequest.INBOX, runBlocking { store.captureDestination() })
    }

    private fun nordCopy(): kotlinx.serialization.json.JsonObject =
        ThemeEdits.duplicate(ThemeCatalogue.bundled.builtIn("nord")!!, "custom-abc", "Nord copy", ThemeCatalogue.bundled)

    @Test
    fun aThemeDuplicatedOfflineIsMadeAndChosenOnTheFirstPassOnline() {
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        val copy = nordCopy()
        assertTrue(change(SettingKeys.THEME, "custom-abc"))
        assertTrue(runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), copy) })
        // Shown at once: chosen, and the app resolves it from the phone's own copy.
        assertEquals("custom-abc", ThemeCatalogue.bundled.resolve(shown().settings).id)
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // One change carrying both, the theme before it is chosen (A416).
        val sent = penmoss.settingsChanges.single()
        assertTrue(sent.getJSONObject("base").isNull(ThemeEdits.key("custom-abc")))
        assertEquals("Nord copy", (penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getString("name"))
        assertEquals("custom-abc", penmoss.settings[SettingKeys.THEME])
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun aThemeEditSurvivesAnotherDevicesEditToTheSameTheme() {
        val copy = nordCopy()
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(copy.toString()))
        assertEquals(PassOutcome.SYNCED, pass())
        // The phone renames it; the settings route is busy, so the tree comes first…
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), ThemeEdits.withName(copy, "Night")) }
        // …and shows the Mac's edit to another field of the same theme.
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(ThemeEdits.withColour(copy, "dark", "bg", "#101418").toString()))
        penmoss.settingsDown = true
        assertEquals(PassOutcome.SYNCED, pass())
        // Not a conflict: the server merges the two (A416), so the phone's edit still goes.
        assertEquals(setOf(ThemeEdits.key("custom-abc")), shown().unsent)
        penmoss.settingsDown = false
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("Night", (penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getString("name"))
        val base = penmoss.settingsChanges.last().getJSONObject("base").getJSONObject(ThemeEdits.key("custom-abc"))
        assertEquals("Nord copy", base.getString("name"))
    }

    @Test
    fun anEditOfAThemeDeletedElsewhereIsDroppedNotBroughtBack() {
        val copy = nordCopy()
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(copy.toString()))
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), ThemeEdits.withName(copy, "Night")) }
        // Deleted on the web meanwhile.
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(ThemeEdits.deletion(copy, ThemeCatalogue.bundled).toString()))
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue((penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getBoolean("deleted"))
        assertEquals(emptySet<String>(), shown().unsent)
        assertTrue(shown().settings.customThemes.none { it.string("id") == "custom-abc" })
    }

    @Test
    fun aDeletionGoesEvenAfterAnotherDevicesEdit() {
        val copy = nordCopy()
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(copy.toString()))
        penmoss.setOnWeb(SettingKeys.THEME, "custom-abc")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), ThemeEdits.deletion(copy, ThemeCatalogue.bundled)) }
        change(SettingKeys.THEME, "nord")
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(ThemeEdits.withName(copy, "Renamed").toString()))
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue((penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getBoolean("deleted"))
        assertEquals("nord", penmoss.settings[SettingKeys.THEME])
    }

    @Test
    fun aColourPutBackAfterALostReplyIsPutBackOnTheServerToo() {
        val copy = nordCopy()
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(copy.toString()))
        assertEquals(PassOutcome.SYNCED, pass())
        val accent = ThemeEdits.colours(copy, "light").getValue("accent")
        // A yellow accent reaches the server, but its reply is lost.
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), ThemeEdits.withColour(copy, "light", "accent", "#d8b04a")) }
        loseSettingsReply = true
        assertEquals(PassOutcome.FAILED, pass())
        assertEquals("#d8b04a", (penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getJSONObject("light").getString("accent"))
        // Offline, Ryan puts the accent back: the theme is as the phone first had it.
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), copy) }
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // The server's merge saw a change and wrote it (A416); the yellow does not come back.
        assertEquals(accent, (penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject).getJSONObject("light").getString("accent"))
        val sentBase = penmoss.settingsChanges.last().getJSONObject("base").getJSONObject(ThemeEdits.key("custom-abc"))
        assertEquals("#d8b04a", sentBase.getJSONObject("light").getString("accent"))
        assertEquals(accent, ThemeEdits.colours(shown().settings.customThemes.single(), "light")["accent"])
        assertEquals(emptySet<String>(), shown().unsent)
    }

    @Test
    fun moreThanTwentySettingsGoTwentyAtATimeThemesFirst() {
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        val nord = ThemeCatalogue.bundled.builtIn("nord")!!
        val ids = (0 until 24).map { "custom-t%02d".format(it) }
        for (id in ids) {
            assertTrue(runBlocking { store.changeSetting(ThemeEdits.key(id), ThemeEdits.duplicate(nord, id, "Copy $id", ThemeCatalogue.bundled)) })
        }
        change(SettingKeys.THEME, ids.last())
        change(SettingKeys.MODE, "dark")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // 26 settings: 20, then 6, the themes before the choice of one of them.
        assertEquals(listOf(20, 6), penmoss.settingsChanges.map { it.getJSONObject("set").length() })
        assertTrue(penmoss.settingsChanges.first().getJSONObject("set").keys().asSequence().all { it.startsWith("theme.custom.") })
        assertEquals(ids.map(ThemeEdits::key).toSet(), penmoss.settings.keys.filter { it.startsWith("theme.custom.") }.toSet())
        assertEquals(ids.last(), penmoss.settings[SettingKeys.THEME])
        assertEquals("dark", penmoss.settings[SettingKeys.MODE])
        assertEquals(emptySet<String>(), shown().unsent)
        assertNull(shown().refused)
    }

    @Test
    fun aThemeMadeHereWhoseReplyWasLostKeepsTheEditMadeSinceAndTheWebsToo() {
        assertEquals(PassOutcome.SYNCED, pass())
        val copy = nordCopy()
        // Made here and sent; the reply is lost.
        assertTrue(runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), copy) })
        loseSettingsReply = true
        assertEquals(PassOutcome.FAILED, pass())
        // The web, which now has it, darkens its dark background; offline, the phone renames it.
        penmoss.setOnWeb(ThemeEdits.key("custom-abc"), JSONObject(ThemeEdits.withColour(copy, "dark", "bg", "#101418").toString()))
        runBlocking { store.changeSetting(ThemeEdits.key("custom-abc"), ThemeEdits.withName(copy, "Night")) }
        // The settings route is busy: the tree comes first, showing the theme as the web left it.
        online = true
        penmoss.settingsDown = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(setOf(ThemeEdits.key("custom-abc")), shown().unsent)
        penmoss.settingsDown = false
        assertEquals(PassOutcome.SYNCED, pass())
        // Both edits stand: the phone's name and the web's background.
        val stored = penmoss.settings[ThemeEdits.key("custom-abc")] as JSONObject
        assertEquals("Night", stored.getString("name"))
        assertEquals("#101418", stored.getJSONObject("dark").getString("bg"))
        assertEquals(emptySet<String>(), shown().unsent)
    }
}
