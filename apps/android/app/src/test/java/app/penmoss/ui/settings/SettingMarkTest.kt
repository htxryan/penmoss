package app.penmoss.ui.settings

import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.keys.CommandRoutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Search Settings' mark on the phone (PEN-148), as the Mac's `[data-setting]`: a result opens its
 * screen scrolled to the row it names, marked a moment, the mark fading; a row that is not drawn
 * in time is given up on.
 */
@RunWith(AndroidJUnit4::class)
class SettingMarkTest {
    @get:Rule
    val compose = createComposeRule()

    private val marked = SemanticsMatcher.expectValue(SettingMarked, true)

    private fun unmarked() = SemanticsMatcher("not marked") { SettingMarked !in it.config }

    @Test
    fun aRowTakesTheMarkOnceAndAMarkNotTakenInTimeIsGivenUp() {
        var now = 0L
        val mark = SettingMark { now }
        mark.request("note-width")
        assertFalse(mark.take("theme"))
        assertTrue(mark.take("note-width"))
        // Once only.
        assertFalse(mark.take("note-width"))
        assertNull(mark.target)
        // A screen that took too long to draw it: not marked.
        mark.request("mode")
        now += SettingMark.WAIT_MS + 1
        assertFalse(mark.take("mode"))
    }

    @Test
    fun theScreenScrollsToTheRowAndMarksItAMomentThenTheMarkFades() {
        val mark = SettingMark()
        mark.request("row-34")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalSettingMark provides mark) {
                    SectionScreen("Appearance", onBack = {}) {
                        for (i in 0 until 40) {
                            ListItem(headlineContent = { Text("Row $i") }, modifier = Modifier.settingRow("row-$i").testTag("row-$i"))
                        }
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(200)
        compose.waitForIdle()
        // Scrolled to it: on screen, the first rows gone above.
        compose.onNodeWithTag("row-34").assertIsDisplayed().assert(marked)
        compose.onNodeWithTag("row-0").assertIsNotDisplayed()
        compose.onNodeWithTag("row-33").assert(unmarked())
        // The tint fades: after the hold and the fade it is no longer marked.
        repeat(((SettingMark.HOLD_MS + SettingMark.FADE_MS) / 100 + 5).toInt()) {
            compose.mainClock.advanceTimeBy(100)
            compose.waitForIdle()
        }
        compose.onNodeWithTag("row-34").assert(unmarked())
        assertNull(mark.target)
    }

    @Test
    fun aResultAsksForItsRowAndOpensItsScreen() {
        val mark = SettingMark()
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalSettingMark provides mark) {
                    SettingsHome(settingsGroups(Settings(), "Penmoss"), onOpen = { opened += it }, onBack = {})
                }
            }
        }
        compose.onNodeWithTag("settingsSearch").performTextInput("in step")
        compose.onNodeWithTag("found-keep-settings-in-step").performClick()
        assertEquals(listOf(CommandRoutes.GIT_NOTEBOOKS), opened)
        assertEquals("keep-settings-in-step", mark.target)
    }

    @Test
    fun everyIndexedSettingHasAnIdItsRowCanCarry() {
        // The ids are the labels in kebab case, as the Mac's data-setting ids are, and unique.
        val ids = SETTINGS_INDEX.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
        assertTrue(ids.all { Regex("^[a-z0-9]+(-[a-z0-9]+)*$").matches(it) })
        assertEquals("copy-settings", settingId("Copy Settings…"))
        assertEquals("what-s-new", settingId("What’s New"))
        assertTrue("keep-settings-in-step" in ids)
    }
}
