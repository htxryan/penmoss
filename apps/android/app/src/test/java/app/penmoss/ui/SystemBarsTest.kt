package app.penmoss.ui

import android.content.Intent
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.AppGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.capture.CaptureActivity
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.stopMainScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The status and navigation bars follow the variant the app shows, not the phone's mode (T40 P1,
 * PL11, A414): Dark chosen on a phone in light mode gives light icons, and the reverse.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SystemBarsTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    private lateinit var graph: AppGraph
    private var scenario: ActivityScenario<out ComponentActivity>? = null

    @After
    fun close() {
        scenario?.close()
        // The app’s work has ended before the database closes, never against a closed pool (A610, A690).
        if (::graph.isInitialized) stopMainScope(graph.scope)
        if (::graph.isInitialized) graph.database.close()
    }

    /** A phone whose device settings (the Journal notebook's, as last read, A1014) say [mode]. */
    private fun phone(mode: String) {
        TestGraphs.forgetNotebooks(app)
        graph = TestGraphs.app(app)
        app.useGraph(graph)
        settle(mode, "h1")
    }

    /** The device settings read again, now saying [mode]. */
    private fun settle(mode: String, hash: String) {
        runBlocking { graph.store.saveTree(SyncTree(hash = hash, settings = JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive(mode))))) }
        // Room answers on its own thread and the app's flows collect on the main looper: wait until
        // the appearance the screen will read has the settings, however slow the machine.
        compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            graph.appearance.value.mode == mode && graph.appearance.value.theme != null
        }
    }

    /** The bars' icons as the activity has them now: (light status bar, light navigation bar). */
    private fun bars(): Pair<Boolean, Boolean> {
        var bars = false to false
        @Suppress("UNCHECKED_CAST")
        (scenario as ActivityScenario<ComponentActivity>).onActivity { activity ->
            val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            bars = controller.isAppearanceLightStatusBars to controller.isAppearanceLightNavigationBars
        }
        return bars
    }

    /**
     * Waits until the bars are [expected], as CaptureActivityTest waits: Robolectric's looper is
     * paused, and the bars change in a composition effect once the screen has drawn.
     */
    private fun assertBars(expected: Pair<Boolean, Boolean>) {
        runCatching {
            compose.waitUntil(5_000) {
                shadowOf(Looper.getMainLooper()).idle()
                bars() == expected
            }
        }
        assertEquals("bars with ${graph.appearance.value.mode} chosen", expected, bars())
    }

    @Test
    fun darkChosenOnAPhoneInLightModeGivesLightIcons() {
        phone("dark")
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertBars(false to false)
    }

    @Test
    @Config(qualifiers = "night")
    fun lightChosenOnAPhoneInDarkModeGivesDarkIcons() {
        phone("light")
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertBars(true to true)
    }

    @Test
    @Config(qualifiers = "night")
    fun systemChosenWhileOpenFollowsThePhone() {
        // Starts on Light, so the bars must change for System to show on this dark phone.
        phone("light")
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertBars(true to true)
        settle("system", "h2")
        assertBars(false to false)
    }

    /** A414's change: the capture sheet's bars followed the phone's mode, not the one chosen. */
    @Test
    @Config(qualifiers = "night")
    fun theCaptureSheetOnADarkPhoneWithLightChosenHasDarkIcons() {
        phone("light")
        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Buy mulch")
        scenario = ActivityScenario.launch<CaptureActivity>(share.setClass(app, CaptureActivity::class.java))
        assertBars(true to true)
    }
}
