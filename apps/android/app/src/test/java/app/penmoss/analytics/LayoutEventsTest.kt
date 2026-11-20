package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's `app layout` event (PEN-174): the drawer shown or hidden, the note's panel open,
 * closed or none, Full Width and the theme's mode, with no tabs and no sidebar width. Recorded
 * once the settings are read, 500 ms after the last change, and only when it differs from the
 * last one.
 */
@RunWith(AndroidJUnit4::class)
class LayoutEventsTest {
    private val session = AnalyticsFormat.newSessionId()
    private val recorded = mutableListOf<Map<String, Any?>>()
    private val settle = FakeSettle()
    private val layout = LayoutEvents(settle, record = { recorded += it; true }, session = { session })

    private fun expected(sidebar: String = "hidden", panel: String = "none", fullWidth: Boolean = false, themeMode: String = "system") =
        mapOf("window" to "main", "sidebar" to sidebar, "panel" to panel, "fullWidth" to fullWidth, "themeMode" to themeMode)

    @Test
    fun nothingIsRecordedUntilTheSettingsAreRead() {
        val home = Any()
        layout.drawer(home, false)
        assertNull(settle.pending)
        layout.settings(fullWidth = false, themeMode = "system")
        assertEquals(LayoutEvents.SETTLE_MS, settle.delayMs)
        settle.fire()
        assertEquals(listOf(expected()), recorded)
        assertTrue("no tabs or sidebar width on a phone", recorded.single().keys.none { it == "tabs" || it == "sidebarWidth" })
    }

    @Test
    fun eachChangeRecordsOnceItSettles() {
        val home = Any()
        val note = Any()
        layout.settings(false, "system")
        // Home shows no note: no panel.
        layout.noPanel(home)
        settle.fire()
        layout.drawer(home, true)
        settle.fire()
        assertEquals(expected(sidebar = "shown"), recorded.last())
        layout.drawer(home, false)
        settle.fire()
        assertEquals(expected(), recorded.last())
        // A note in front, its panel opened, then closed.
        layout.panel(note, false)
        layout.panel(note, true)
        settle.fire()
        assertEquals(expected(panel = "open"), recorded.last())
        layout.settings(true, "dark")
        settle.fire()
        assertEquals(expected(panel = "open", fullWidth = true, themeMode = "dark"), recorded.last())
        // Back to Home: its "no panel" is in front again.
        layout.panelGone(note)
        settle.fire()
        assertEquals(expected(fullWidth = true, themeMode = "dark"), recorded.last())
        assertEquals(6, recorded.size)
    }

    @Test
    fun changesWithinTheSettleGiveOneRecordAndNoneWhenNothingDiffers() {
        val home = Any()
        layout.settings(false, "light")
        settle.fire()
        layout.drawer(home, true)
        layout.drawer(home, false)
        settle.fire()
        assertEquals("open and closed again: the same layout", 1, recorded.size)
        // Full Width on, off and on again within the settle: one record, of where it ended.
        repeat(3) { layout.settings(it % 2 == 0, "light") }
        settle.fire()
        assertEquals(2, recorded.size)
        assertEquals(expected(fullWidth = true, themeMode = "light"), recorded.last())
    }

    @Test
    fun theNoteThatLeftDoesNotTakeTheNextOnesPanel() {
        val first = Any()
        val next = Any()
        layout.settings(false, "system")
        layout.panel(first, true)
        // The next note comes in before the first one's screen goes.
        layout.panel(next, false)
        layout.panelGone(first)
        settle.fire()
        assertEquals(expected(panel = "closed"), recorded.last())
    }

    @Test
    fun anUnknownModeIsSystem() {
        layout.settings(false, "sepia")
        settle.fire()
        assertEquals("system", recorded.last()["themeMode"])
    }

    @Test
    fun whatItRecordsIsAValidEventAndIsStored() = runBlocking {
        AnalyticsHarness().use { harness ->
            Analytics.install(harness.service)
            try {
                val settle = FakeSettle()
                val layout = LayoutEvents(settle)
                layout.settings(true, "dark")
                layout.drawer(Any(), true)
                layout.panel(Any(), true)
                settle.fire()
                harness.service.flush()
                val stored = harness.store.page(null, null, 10)
                assertEquals(listOf("app" to "layout"), stored.map { it.kind to it.name })
                assertTrue(stored.single().props, stored.single().props.contains("\"sidebar\":\"shown\""))
            } finally {
                Analytics.install(null)
            }
        }
    }

    /** Ryan's review: Settings fills the window, and the layout behind it is still the window's. */
    @Test
    fun settingsKeepsTheNotesPanelAndAThemeChangeThereRecordsIt() {
        val home = Any()
        val note = Any()
        layout.settings(false, "system")
        layout.noPanel(home)
        layout.drawer(home, false)
        // A note in front with its panel open; Home leaves.
        layout.panel(note, true)
        layout.noPanelGone(home)
        layout.drawerGone(home)
        settle.fire()
        assertEquals(expected(panel = "open"), recorded.last())
        // Settings from the note's menu: the note goes, and nothing new is recorded.
        layout.panelGone(note)
        settle.fire()
        assertEquals(1, recorded.size)
        // The theme to Dark there: the layout still has the note's panel open.
        layout.settings(false, "dark")
        settle.fire()
        assertEquals(expected(panel = "open", themeMode = "dark"), recorded.last())
        layout.settings(true, "dark")
        settle.fire()
        assertEquals(expected(panel = "open", fullWidth = true, themeMode = "dark"), recorded.last())
    }

    @Test
    fun settingsKeepsTheDrawerAsHomeLeftIt() {
        val home = Any()
        layout.settings(false, "system")
        layout.noPanel(home)
        layout.drawer(home, true)
        settle.fire()
        assertEquals(expected(sidebar = "shown"), recorded.last())
        // Settings from the drawer's row, with the drawer still open as Home goes.
        layout.drawerGone(home)
        layout.noPanelGone(home)
        layout.settings(false, "light")
        settle.fire()
        assertEquals(expected(sidebar = "shown", themeMode = "light"), recorded.last())
        // Back to Home, its drawer closed: Home's own parts again.
        val again = Any()
        layout.noPanel(again)
        layout.drawer(again, false)
        settle.fire()
        assertEquals(expected(themeMode = "light"), recorded.last())
    }
}
