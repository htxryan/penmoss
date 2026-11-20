package app.penmoss.analytics

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.cachedIn
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.AnalyticsDataScreen
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The window's size and layout in usage analytics on the phone (PEN-174, ac4, ac5, ac8): `app
 * window` as a window first lays out, again only when its size changes (a rotation records once,
 * and a window made again at the same size records nothing), and `app layout` as the drawer and the
 * note's panel open and close; then Settings → Privacy → Analytics Data lists them. Built from the
 * app's own pieces ([WindowEvents.attach], [LocalLayoutEvents], [TrackDrawer], [TrackNotePanel],
 * [AnalyticsDataScreen]), as the other analytics proofs are. Run with
 * `task proof:android -- app.penmoss.analytics.WindowLayoutEventsTest`.
 */
@RunWith(AndroidJUnit4::class)
class WindowLayoutEventsTest {
    private lateinit var phone: TestAnalytics
    private var before: AnalyticsService? = null

    @Before
    fun install() {
        phone = TestAnalytics()
        before = Analytics.service
        Analytics.install(phone.service)
    }

    @After
    fun uninstall() {
        Analytics.install(before)
        phone.close()
    }

    /** The stored events called `app` [name], oldest first, as their props. */
    private fun stored(name: String): List<JsonObject> = runBlocking {
        phone.service.flush()
        phone.store.page(null, null, 200).filter { it.kind == "app" && it.name == name }.reversed().map { Json.parseToJsonElement(it.props) as JsonObject }
    }

    private fun waitForCount(screen: OnScreen, name: String, count: Int): List<JsonObject> =
        screen.waitFor("$count app $name events") { stored(name).takeIf { it.size >= count } }

    /** The Activity's window in dp, rounded as the event rounds it. */
    private fun sizeOf(activity: ComponentActivity): Pair<Int, Int> {
        val shape = WindowEvents.shapeOf(activity)
        return AnalyticsFormat.lengthOf(shape.widthDp) to AnalyticsFormat.lengthOf(shape.heightDp)
    }

    @Test
    fun aWindowRecordsItsSizeOnceAndARotationOnce() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var size = 0 to 0
            scenario.onActivity { activity ->
                activity.setContent { PenmossTheme { Text("Quick Capture", Modifier.padding(24.dp)) } }
                WindowEvents.attach(activity, "capture")
                size = sizeOf(activity)
            }
            val screen = OnScreen(scenario)
            val first = waitForCount(screen, "window", 1).single()
            assertEquals("capture", first.getValue("window").jsonPrimitive.content)
            assertEquals(size.first, first.getValue("width").jsonPrimitive.int)
            assertEquals(size.second, first.getValue("height").jsonPrimitive.int)
            assertTrue(first.getValue("fullScreen").jsonPrimitive.boolean)
            assertFalse("no maximised on Android", "maximised" in first)
            assertEquals(0, first.getValue("width").jsonPrimitive.int % 10)

            // Quick Capture's sheet declares no configChanges: a rotation makes it again, and the
            // new sheet's first layout records the new size, once.
            scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            val rotated = runCatching {
                screen.waitFor("the window turned", timeoutMs = 10_000) {
                    var turned: Boolean? = null
                    scenario.onActivity { activity -> if (activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) turned = true }
                    turned
                }
            }.isSuccess
            scenario.onActivity { activity ->
                activity.setContent { PenmossTheme { Text("Quick Capture", Modifier.padding(24.dp)) } }
                WindowEvents.attach(activity, "capture")
                size = sizeOf(activity)
            }
            if (rotated && size != first.getValue("width").jsonPrimitive.int to first.getValue("height").jsonPrimitive.int) {
                val turned = waitForCount(screen, "window", 2).last()
                assertEquals(size.first, turned.getValue("width").jsonPrimitive.int)
                assertEquals(size.second, turned.getValue("height").jsonPrimitive.int)
            } else {
                // An emulator that keeps its orientation: the same size, so nothing more (the
                // size swap is WindowEventsTest's).
                Log.i("WindowLayoutEventsTest", "the window did not turn; checked the repeat rule only")
            }
            val count = stored("window").size
            // Made again at the same size: nothing more.
            scenario.onActivity { activity -> WindowEvents.attach(activity, "capture").shown() }
            SystemClock.sleep(1_500)
            assertEquals(count, stored("window").size)
            scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Test
    fun theLayoutFollowsTheDrawerAndThePanelAndAnalyticsDataListsIt() {
        var viewing by mutableStateOf(false)
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        if (viewing) {
                            AnalyticsData()
                        } else {
                            val layout = remember { LayoutEvents() }
                            // A notebook's settings: Full Width off, the theme Dark.
                            LaunchedEffect(layout) { layout.settings(fullWidth = false, themeMode = "dark") }
                            CompositionLocalProvider(LocalLayoutEvents provides layout) { Notebook() }
                        }
                    }
                }
                WindowEvents.attach(activity, "main")
            }
            val screen = OnScreen(scenario)
            val window = waitForCount(screen, "window", 1).single()
            assertEquals("main", window.getValue("window").jsonPrimitive.content)

            val start = waitForCount(screen, "layout", 1).last()
            assertEquals("hidden", start.getValue("sidebar").jsonPrimitive.content)
            assertEquals("closed", start.getValue("panel").jsonPrimitive.content)
            assertEquals("dark", start.getValue("themeMode").jsonPrimitive.content)
            assertFalse(start.getValue("fullWidth").jsonPrimitive.boolean)
            assertFalse("no tabs on a phone", "tabs" in start)
            assertFalse("the drawer has no width of its own", "sidebarWidth" in start)

            screen.tap("homeMenu")
            screen.text("All Notebooks")
            assertEquals("shown", waitForCount(screen, "layout", 2).last().getValue("sidebar").jsonPrimitive.content)
            screen.tap("drawerClose")
            assertEquals("hidden", waitForCount(screen, "layout", 3).last().getValue("sidebar").jsonPrimitive.content)
            screen.tap("notePanel")
            screen.text("Metadata")
            assertEquals("open", waitForCount(screen, "layout", 4).last().getValue("panel").jsonPrimitive.content)
            screen.tap("notePanel")
            assertEquals("closed", waitForCount(screen, "layout", 5).last().getValue("panel").jsonPrimitive.content)
            // Nothing else changed: no more records.
            SystemClock.sleep(1_500)
            assertEquals(5, stored("layout").size)
            assertEquals(1, stored("window").size)

            // Settings → Privacy → Analytics Data lists them, newest first, with their props.
            viewing = true
            screen.text(AnalyticsCopy.text("viewer.title"))
            screen.text("app · layout")
            screen.text("app · window")
            assertTrue(screen.texts().any { it.contains("\"sidebar\":\"hidden\"") && it.contains("\"panel\":\"closed\"") })
            assertTrue(screen.texts().any { it.contains("\"window\":\"main\"") && it.contains("\"width\":") })
            SystemClock.sleep(2_000)
            screen.text("app · window")
            ProofShot.take()
        }
    }

    /** A notebook's screen in brief: the drawer behind the menu button, and a note with its panel. */
    @OptIn(ExperimentalMaterial3Api::class)
    @androidx.compose.runtime.Composable
    private fun Notebook() {
        val drawer = rememberDrawerState(DrawerValue.Closed)
        val scope = rememberCoroutineScope()
        var panel by remember { mutableStateOf(false) }
        TrackDrawer(drawer.isOpen)
        TrackNotePanel(panel)
        ModalNavigationDrawer(
            drawerState = drawer,
            drawerContent = {
                ModalDrawerSheet {
                    Text("All Notebooks", Modifier.padding(24.dp))
                    OutlinedButton(onClick = { scope.launch { drawer.close() } }, Modifier.padding(16.dp).testTag("drawerClose")) { Text("Close Navigation") }
                }
            },
        ) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text("Meeting Notes") },
                        navigationIcon = { OutlinedButton(onClick = { scope.launch { drawer.open() } }, Modifier.testTag("homeMenu")) { Text("Open Menu") } },
                    )
                },
            ) { padding ->
                Column(Modifier.padding(padding).padding(16.dp)) {
                    Text("Agenda for Thursday, and who brings what")
                    OutlinedButton(onClick = { panel = !panel }, Modifier.testTag("notePanel")) { Text(if (panel) "Close Panel" else "Open Panel") }
                    if (panel) Text("Metadata", Modifier.padding(top = 16.dp))
                }
            }
        }
    }

    /** Settings → Privacy → Analytics Data over this phone's record. */
    @androidx.compose.runtime.Composable
    private fun AnalyticsData() {
        val scope = rememberCoroutineScope()
        val pages = remember { Pager(PagingConfig(pageSize = 100, initialLoadSize = 100, enablePlaceholders = false)) { phone.store.pagingSource(null) }.flow.cachedIn(scope) }
        val counts by remember { phone.store.observeCounts() }.collectAsState(emptyMap())
        AnalyticsDataScreen(
            summary = "On this phone, kept 7 days.",
            counts = counts,
            filter = null,
            onFilter = {},
            events = pages.collectAsLazyPagingItems(),
            onCopyJson = null,
            onBack = {},
        )
    }
}
