package app.penmoss.analytics

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.home.DrawerNotebook
import app.penmoss.ui.home.HomeActions
import app.penmoss.ui.home.HomeDrawerSheet
import app.penmoss.ui.home.HomeUi
import app.penmoss.ui.settings.SectionScreen
import app.penmoss.ui.settings.SettingsGroup
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.SettingsSection
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Where the phone's scrollers record (PEN-175): the drawer as `sidebar`, a Settings page as
 * `settings`, Settings' list of pages as `settings.nav`; the launcher's home, which is no Settings
 * page, records nothing. On a clock the test moves, so the settle and the gap are the gate's.
 */
@RunWith(AndroidJUnit4::class)
class TrackScrollTest {
    @get:Rule
    val compose = createComposeRule()

    private val clock = FakeScrollClock()
    private val recorded = mutableListOf<Pair<String, Double>>()

    @Before
    fun fake() {
        ScrollEvents.forget()
        ScrollEvents.clock = { clock }
        ScrollEvents.record = { area, position -> recorded += area to position }
    }

    @After
    fun real() {
        ScrollEvents.forget()
        ScrollEvents.clock = { ScrollClock.main() }
        ScrollEvents.record = { area, position -> Analytics.record("scroll", area, ScrollEvents.propsOf(position)) }
    }

    private fun swipe(tag: String) {
        compose.onNodeWithTag(tag).performTouchInput { swipeUp(startY = bottom - 10f, endY = top + 10f, durationMillis = 600) }
        compose.waitForIdle()
    }

    /** The gate's settle and gap pass. */
    private fun settle() {
        compose.waitForIdle()
        clock.advance(clock.now() + 5_000)
    }

    @Test
    fun aSettingsPageRecordsSettingsOnceItSettles() {
        compose.setContent {
            PenmossTheme {
                SectionScreen("Appearance", onBack = {}) {
                    Text("First row")
                    Spacer(Modifier.height(4000.dp))
                }
            }
        }
        settle()
        assertEquals("a page that opens at the top records nothing", emptyList<Pair<String, Double>>(), recorded)
        swipe("sectionPage")
        assertTrue("nothing before it settles", recorded.isEmpty())
        settle()
        assertEquals(listOf("settings"), recorded.map { it.first })
        assertTrue("${recorded.single()}", recorded.single().second in 0.01..1.0)
    }

    @Test
    fun anotherPageStartsAgainFromTheTopSoWhereItShowsIsRecordedAgain() {
        var page by mutableStateOf("Appearance")
        compose.setContent {
            PenmossTheme {
                SectionScreen(page, onBack = {}) {
                    Text("First row of $page")
                    Spacer(Modifier.height(4000.dp))
                }
            }
        }
        swipe("sectionPage")
        settle()
        assertEquals(1, recorded.size)
        // Another page in the same scroller, left where it was: as a replay reads it, the new
        // page started at the top and moved there, so it records again (core's reset).
        page = "Shortcuts"
        settle()
        assertEquals(listOf("settings", "settings"), recorded.map { it.first })
        assertEquals(recorded[0].second, recorded[1].second, 0.0)
    }

    @Test
    fun theLaunchersHomeIsNoSettingsPage() {
        compose.setContent {
            PenmossTheme {
                SectionScreen("Penmoss", onBack = null, info = false, scrollArea = null) {
                    Text("Notebooks")
                    Spacer(Modifier.height(4000.dp))
                }
            }
        }
        swipe("sectionPage")
        settle()
        assertTrue("$recorded", recorded.isEmpty())
    }

    @Test
    fun theDrawerRecordsSidebar() {
        val notebooks = (1..30).map { DrawerNotebook("nb$it", "Notebook $it") }
        compose.setContent { PenmossTheme { HomeDrawerSheet(HomeUi(notebooks = notebooks, notebookId = "nb1"), HomeActions(), close = {}) } }
        swipe("homeDrawerList")
        settle()
        assertEquals(listOf("sidebar"), recorded.map { it.first })
    }

    @Test
    fun settingsListOfPagesRecordsSettingsNav() {
        val sections = (1..30).map { SettingsSection("s$it", "Section $it", "Its summary") }
        compose.setContent { PenmossTheme { SettingsHome(listOf(SettingsGroup("Look and Feel", sections)), onOpen = {}, onBack = {}) } }
        swipe("settingsSections")
        settle()
        assertEquals(listOf("settings.nav"), recorded.map { it.first })
        assertTrue("${recorded.single()}", recorded.single().second in 0.01..1.0)
    }
}
