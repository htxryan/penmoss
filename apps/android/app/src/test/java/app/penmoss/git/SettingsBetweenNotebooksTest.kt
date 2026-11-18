package app.penmoss.git

import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Between Notebooks on the phone (A1137, A1550; PEN-148): Copy Settings… makes one notebook's
 * settings another's, leaving Quick Access and the badge each its own, and Keep Settings in Step
 * copies each change of the primary's to the others a moment after, only while it is on.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsBetweenNotebooksTest {
    private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

    private val pins = JsonArray(listOf(JsonPrimitive("01JBGITN0TE00000000000000A")))

    private val work = NotebookSettings(
        device = obj(
            SettingKeys.THEME to JsonPrimitive("nord"),
            SettingKeys.MODE to JsonPrimitive("dark"),
            SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(17),
            SettingKeys.QUICK_ACCESS to pins,
            COPY_TAGS_SETTING to JsonPrimitive(false),
        ),
        own = obj(
            SettingKeys.TIME_ZONE to JsonPrimitive("Europe/London"),
            SettingKeys.DAILY_TEMPLATE to JsonPrimitive("## Today\n"),
            "badge.color" to JsonPrimitive("#336699"),
        ),
    )

    private val home = NotebookSettings(
        device = obj(
            SettingKeys.THEME to JsonPrimitive("paper"),
            SettingKeys.MODE to JsonPrimitive("dark"),
            SettingKeys.FULL_WIDTH to JsonPrimitive(true),
            SettingKeys.QUICK_ACCESS to JsonArray(emptyList()),
        ),
        own = obj(
            SettingKeys.TIME_ZONE to JsonPrimitive("America/Chicago"),
            SettingKeys.WEEKLY_TEMPLATE to JsonPrimitive("## Week\n"),
            "badge.glyph" to JsonPrimitive("H"),
        ),
    )

    @Test
    fun copySettingsWritesWhatDiffersRemovesWhatTheFirstLacksAndLeavesQuickAccessTheBadgeAndTheLook() {
        val changes = SettingsCopy.changes(work, home)
        // The device map: Copy Tags written. Quick Access's pins are Home's own, and the theme,
        // the size and Full Width are each device's (A1626).
        assertEquals(mapOf(COPY_TAGS_SETTING to JsonPrimitive(false)), changes.device)
        // Its own: the time zone and the daily template written, the weekly one removed; the badge stays.
        assertEquals(
            mapOf(
                SettingKeys.TIME_ZONE to JsonPrimitive("Europe/London"),
                SettingKeys.DAILY_TEMPLATE to JsonPrimitive("## Today\n"),
                SettingKeys.WEEKLY_TEMPLATE to null,
            ),
            changes.own,
        )
        assertEquals(4, changes.size)
        assertTrue(SettingsCopy.notCopied(SettingKeys.QUICK_ACCESS))
        assertTrue(SettingsCopy.notCopied("badge.color"))
        assertTrue(SettingsCopy.notCopied(SettingKeys.THEME))
    }

    @Test
    fun copySettingsChangesNothingWhenTheyAlreadyMatchSoNothingCommits() {
        // Only Quick Access and the badge differ: nothing to write.
        val same = work.copy(
            device = JsonObject(work.device + (SettingKeys.QUICK_ACCESS to JsonArray(emptyList()))),
            own = JsonObject(work.own + ("badge.color" to JsonPrimitive("#000000"))),
        )
        assertTrue(SettingsCopy.changes(work, same).isEmpty)
        assertEquals("Home already had these settings.", copiedWords("Work", "Home", 0))
        assertEquals("The other notebooks already had these settings.", copiedWords("Work", null, 0))
        assertEquals("Copied Work’s settings to Home.", copiedWords("Work", "Home", 3))
        assertEquals("Copied Work’s settings to the other notebooks.", copiedWords("Work", null, 9))
    }

    @Test
    fun keepSettingsInStepCopiesThePrimarysChangesToEveryOtherOnlyWhileOn() = runTest {
        val on = MutableStateFlow(false)
        val primary = MutableStateFlow<NotebookSettings?>(null)
        val others = MutableStateFlow(listOf("home"))
        val copied = mutableListOf<Pair<String, String?>>()
        val job = launch {
            SettingsCopy.keepInStep(on, primary, others) { from, to ->
                copied += to to (from.device[SettingKeys.THEME] as? JsonPrimitive)?.content
            }
        }
        primary.value = work
        advanceTimeBy(1_000)
        runCurrent()
        // Off: nothing goes anywhere.
        assertEquals(emptyList<Pair<String, String?>>(), copied)

        // Turned on: the primary's settings go once, a moment after.
        on.value = true
        runCurrent()
        assertEquals(emptyList<Pair<String, String?>>(), copied)
        advanceTimeBy(SettingsCopy.IN_STEP_DELAY_MS + 1)
        runCurrent()
        assertEquals(listOf("home" to "nord"), copied)

        // A change, then another within the moment: only the last goes.
        primary.value = work.copy(device = JsonObject(work.device + (SettingKeys.THEME to JsonPrimitive("slate"))))
        advanceTimeBy(100)
        primary.value = work.copy(device = JsonObject(work.device + (SettingKeys.THEME to JsonPrimitive("paper"))))
        advanceTimeBy(SettingsCopy.IN_STEP_DELAY_MS + 1)
        runCurrent()
        assertEquals(listOf("home" to "nord", "home" to "paper"), copied)

        // A notebook added: it gets the primary's settings too.
        others.value = listOf("home", "garden")
        advanceTimeBy(SettingsCopy.IN_STEP_DELAY_MS + 1)
        runCurrent()
        assertEquals(listOf("home" to "paper", "garden" to "paper"), copied.drop(2))

        // Turned off: a change stays in the primary.
        on.value = false
        runCurrent()
        primary.value = work
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(4, copied.size)
        job.cancel()
    }

    @Test
    fun aCopyThatFailsLeavesTheOthersToBeCopiedAndIsSaid() = runTest {
        val failures = mutableListOf<Throwable>()
        val copied = mutableListOf<String>()
        val job = launch {
            SettingsCopy.keepInStep(MutableStateFlow(true), MutableStateFlow(work), MutableStateFlow(listOf("home", "garden")), onFailure = { failures += it }) { _, to ->
                if (to == "home") error("Home's page is opening")
                copied += to
            }
        }
        advanceTimeBy(SettingsCopy.IN_STEP_DELAY_MS + 1)
        runCurrent()
        assertEquals(listOf("garden"), copied)
        assertEquals("Home's page is opening", failures.single().message)
        job.cancel()
    }
}
