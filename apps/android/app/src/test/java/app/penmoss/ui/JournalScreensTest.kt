package app.penmoss.ui

import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.ui.screens.JournalScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Daily and weekly notes on the phone (T40 P5): the Journal calendar and the period row
 * under a periodic note's top bar. Taps are real clicks at each node's centre, so they also
 * prove nothing sits over a target (TalkBack order and large text are in the Pixel checklist).
 */
@RunWith(RobolectricTestRunner::class)
class JournalScreensTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    /** A tap at the node's centre, hit-tested as a finger's would be. */
    private fun click(tag: String) {
        compose.onNodeWithTag(tag).performClick()
    }

    @Test
    fun theCalendarShowsAMonthWithMarksAndOpensDaysAndWeeks() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                JournalScreen(
                    timeZone = "America/Chicago",
                    marks = JournalMarks(setOf("2026-10-21"), setOf("2026-W43")),
                    onBack = { events += "back" },
                    onOpenDay = { events += "day:$it" },
                    onOpenWeek = { events += "week:$it" },
                    onOpenToday = { events += "today" },
                    initial = JournalMonth(2026, 10),
                )
            }
        }
        compose.onNodeWithText("October 2026").assertExists()
        // TalkBack reads each cell as the web names it (review S7).
        compose.onNodeWithTag("journalDay-2026-10-21").assertContentDescriptionEquals("Wednesday 21 October 2026, has a note")
        compose.onNodeWithTag("journalDay-2026-10-22").assertContentDescriptionEquals("Thursday 22 October 2026")
        compose.onNodeWithTag("journalWeek-2026-W43").assertContentDescriptionEquals("Week 2026-W43, has a note")
        compose.onNodeWithTag("journalWeek-2026-W44").assertContentDescriptionEquals("Week 2026-W44")
        click("journalWeek-2026-W43")
        click("journalDay-2026-10-21")
        // Today opens today's note, as the web calendar's Today button runs `journal.today`.
        click("journalToday")
        assertEquals(listOf("week:2026-10-19", "day:2026-10-21", "today"), events)
    }

    @Test
    fun theCalendarMovesBetweenMonths() {
        compose.setContent {
            PenmossTheme {
                JournalScreen(
                    timeZone = "America/Chicago",
                    marks = JournalMarks(),
                    onBack = {},
                    onOpenDay = {},
                    onOpenWeek = {},
                    onOpenToday = {},
                    initial = JournalMonth(2026, 10),
                )
            }
        }
        compose.onNodeWithText("October 2026").assertExists()
        click("journalPrev")
        compose.onNodeWithText("September 2026").assertExists()
        click("journalNext")
        click("journalNext")
        compose.onNodeWithText("November 2026").assertExists()
    }

    private fun dailyNav() = FromEditor.PeriodicNavData(
        ToEditor.PeriodKind.DAILY,
        "2026-10-21",
        "Wednesday 21 October 2026",
        FromEditor.NavTarget("2026-10-20", "2026-10-20", "Tuesday 20 October 2026", "2026-10-20"),
        FromEditor.NavTarget("2026-10-22", "2026-10-22", "Thursday 22 October 2026", "2026-10-22"),
        FromEditor.NavTarget("2026-10-19", "Week 2026-W43", "Week of Monday 19 October 2026", "2026-W43"),
        null,
    )

    @Test
    fun thePeriodRowShowsThePeriodAndItsNeighbours() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                app.penmoss.ui.PeriodNavRow(dailyNav(), onOpenPeriodic = { kind, date -> events += "${kind.wire}:$date" })
            }
        }
        compose.onNodeWithText("Wednesday 21 October 2026").assertExists()
        compose.onNodeWithTag("periodPrev").assertTextEquals("2026-10-20")
        compose.onNodeWithTag("periodNext").assertTextEquals("2026-10-22")
        click("periodPrev")
        click("periodNext")
        click("periodWeek")
        assertEquals(listOf("daily:2026-10-20", "daily:2026-10-22", "weekly:2026-10-19"), events)
    }

    @Test
    fun thePeriodRowShowsAWeeksSevenDays() {
        val events = mutableListOf<String>()
        val days = (19..25).map { day ->
            FromEditor.NavTarget("2026-10-$day", "Oct $day", "October $day 2026", "2026-10-$day")
        }
        val nav = FromEditor.PeriodicNavData(
            ToEditor.PeriodKind.WEEKLY,
            "2026-W43",
            "Week 2026-W43",
            FromEditor.NavTarget("2026-10-12", "2026-W42", "Week of Monday 12 October 2026", "2026-W42"),
            FromEditor.NavTarget("2026-10-26", "2026-W44", "Week of Monday 26 October 2026", "2026-W44"),
            null,
            days,
        )
        compose.setContent {
            PenmossTheme {
                app.penmoss.ui.PeriodNavRow(nav, onOpenPeriodic = { kind, date -> events += "${kind.wire}:$date" })
            }
        }
        click("periodDay-2026-10-21")
        click("periodPrev")
        assertEquals(listOf("daily:2026-10-21", "weekly:2026-10-12"), events)
    }

    @Test
    fun theDaysAndWeekThatHaveANoteAreMarked() {
        // P5 review N4: the web marks them (`data-has-note`); the phone showed none.
        val days = (19..25).map { day ->
            FromEditor.NavTarget("2026-10-$day", "Oct $day", "October $day 2026", "2026-10-$day")
        }
        val weekly = FromEditor.PeriodicNavData(
            ToEditor.PeriodKind.WEEKLY,
            "2026-W43",
            "Week 2026-W43",
            FromEditor.NavTarget("2026-10-12", "2026-W42", "Week of Monday 12 October 2026", "2026-W42"),
            FromEditor.NavTarget("2026-10-26", "2026-W44", "Week of Monday 26 October 2026", "2026-W44"),
            null,
            days,
        )
        var nav by mutableStateOf(weekly)
        val marks = JournalMarks(days = setOf("2026-10-20", "2026-10-23"), weeks = setOf("2026-W43"))
        compose.setContent {
            PenmossTheme { app.penmoss.ui.PeriodNavRow(nav, onOpenPeriodic = { _, _ -> }, marks = marks) }
        }
        compose.onNodeWithTag("periodDay-2026-10-20-held", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("periodDay-2026-10-23-held", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("periodDay-2026-10-21-held", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("October 20 2026, has a note").assertExists()
        compose.onNodeWithContentDescription("October 21 2026").assertExists()
        // A daily note's week chip, when the week has its note.
        nav = dailyNav()
        compose.onNodeWithTag("periodWeek-held", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Week of Monday 19 October 2026, has a note").assertExists()
    }
}
