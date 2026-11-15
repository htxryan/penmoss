package app.penmoss.git

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertContentDescriptionContains
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.DEVICE_ONLY_TIP
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * All Notebooks → Between Notebooks and a notebook's Overview on the phone (A1137, A1550;
 * PEN-148), as the Mac's: Keep Settings in Step and Copy Settings… only with two notebooks or
 * more, Copy Settings… with From and To, and the page's Notes row.
 */
@RunWith(AndroidJUnit4::class)
class BetweenNotebooksScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private fun view(localId: String, name: String) = GitNotebookView(
        localId = localId,
        notebookId = "N-$localId",
        name = name,
        create = false,
        remote = "https://github.com/htxryan/${name.lowercase()}",
        repository = "github.com/htxryan/${name.lowercase()}",
        host = "github.com",
        branch = "main",
        dir = "",
        pushDelayS = 12,
        pullEveryMin = 1,
        wifiOnly = false,
        hasToken = true,
    )

    private val work = GitRow(view("w", "Work"), null)
    private val home = GitRow(view("h", "Home"), null)
    private val garden = GitRow(view("g", "Garden"), null)

    @Test
    fun withOneNotebookThereIsNothingToKeepInStepOrCopy() {
        compose.setContent {
            PenmossTheme { GitNotebooksScreen(GitNotebooksUi(rows = listOf(work), journal = "w", copyTags = true), GitNotebooksActions(), onBack = {}) }
        }
        compose.onNodeWithTag("gitCopyTags").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("gitSettingsInStep").assertDoesNotExist()
        compose.onNodeWithTag("gitCopySettingsOpen").assertDoesNotExist()
    }

    @Test
    fun keepSettingsInStepIsThisPhonesSwitchNamingThePrimary() {
        val turned = mutableListOf<Boolean>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(work, home), journal = "w", copyTags = true),
                    GitNotebooksActions(onInStep = { turned += it }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitSettingsInStep").performScrollTo().assertIsOff()
        compose.onNodeWithText("A change to Work’s settings goes to the other notebooks").assertIsDisplayed()
        // This phone's own: the laptop mark, its sentence what TalkBack reads with the row (A1559).
        compose.onNode(hasTestTag("deviceOnly") and hasAnyAncestor(hasTestTag("gitSettingsInStep")), useUnmergedTree = true)
            .assertContentDescriptionEquals(DEVICE_ONLY_TIP)
        compose.onNodeWithTag("gitSettingsInStep").assertContentDescriptionContains(DEVICE_ONLY_TIP)
        compose.onNodeWithTag("gitSettingsInStep").performClick()
        assertEquals(listOf(true), turned)
    }

    @Test
    fun keepSettingsInStepShowsOnWhenChosen() {
        compose.setContent {
            PenmossTheme { GitNotebooksScreen(GitNotebooksUi(rows = listOf(work, home), journal = "h", copyTags = true, inStep = true), GitNotebooksActions(), onBack = {}) }
        }
        compose.onNodeWithTag("gitSettingsInStep").performScrollTo().assertIsOn()
        compose.onNodeWithText("A change to Home’s settings goes to the other notebooks").assertIsDisplayed()
    }

    @Test
    fun copySettingsCopiesFromThePrimaryToTheOtherOnceAndSaysSo() {
        val copies = mutableListOf<Pair<String, String?>>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(work, home), journal = "w", copyTags = true),
                    GitNotebooksActions(onCopySettings = { from, to -> copies += from to to; "Copied Work’s settings to Home." }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitCopySettingsOpen").performScrollTo().performClick()
        compose.onNodeWithTag("gitCopyFrom-shown", useUnmergedTree = true).assertTextEquals("Work ›")
        compose.onNodeWithTag("gitCopyTo-shown", useUnmergedTree = true).assertTextEquals("Home ›")
        compose.onNodeWithText("Replaces Home’s settings with Work’s: the theme, Home, shortcuts and the rest. Quick Access stays as it is.").assertIsDisplayed()
        compose.onNodeWithTag("gitCopySettings").performClick()
        compose.waitForIdle()
        assertEquals(listOf("w" to "h"), copies)
        compose.onNodeWithTag("gitCopySettingsDone").assertTextEquals("Copied Work’s settings to Home.")
        compose.onNodeWithTag("gitCopySettingsClose").assertTextEquals("Done")
    }

    @Test
    fun withThreeNotebooksCopySettingsStartsOnEveryOtherNotebookAndCanPickOne() {
        val copies = mutableListOf<Pair<String, String?>>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(work, home, garden), journal = "w", copyTags = true),
                    GitNotebooksActions(onCopySettings = { from, to -> copies += from to to; "" }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitCopySettingsOpen").performScrollTo().performClick()
        compose.onNodeWithTag("gitCopyTo-shown", useUnmergedTree = true).assertTextEquals("Every Other Notebook ›")
        compose.onNodeWithText("Replaces their settings with Work’s: the theme, Home, shortcuts and the rest. Quick Access stays as it is.").assertIsDisplayed()
        compose.onNodeWithTag("gitCopySettings").performClick()
        compose.waitForIdle()
        // From Garden, to Home.
        compose.onNodeWithTag("gitCopyFrom").performClick()
        compose.onNodeWithTag("gitCopyFrom-g").performClick()
        compose.onNodeWithTag("gitCopyTo").performClick()
        compose.onNodeWithTag("gitCopyTo-h").performClick()
        compose.onNodeWithTag("gitCopyTo-shown", useUnmergedTree = true).assertTextEquals("Home ›")
        compose.onNodeWithTag("gitCopySettings").performClick()
        compose.waitForIdle()
        assertEquals(listOf("w" to null, "g" to "h"), copies)
    }

    @Test
    fun aNotebooksOverviewSaysHowManyNotesAndCopiesThePrimarysSettingsIntoIt() {
        val copies = mutableListOf<Pair<String, String?>>()
        val ui = GitNotebooksUi(rows = listOf(work, home), journal = "w")
        val actions = GitNotebooksActions(onCopySettings = { from, to -> copies += from to to; "" })
        compose.setContent { PenmossTheme { NotebookPage(home, ui, actions, NotebookTab.OVERVIEW, onBack = {}, notes = 1_234) } }
        compose.onNodeWithTag("gitNoteCount-h", useUnmergedTree = true).assertTextEquals("1,234 notes")
        compose.onNodeWithTag("gitCopySettingsOpen-h").performScrollTo().performClick()
        // Another notebook's page: the primary's settings into this one, as the Mac's.
        compose.onNodeWithTag("gitCopyFrom-shown", useUnmergedTree = true).assertTextEquals("Work ›")
        compose.onNodeWithTag("gitCopyTo-shown", useUnmergedTree = true).assertTextEquals("Home ›")
        compose.onNodeWithTag("gitCopySettings").performClick()
        compose.waitForIdle()
        assertEquals(listOf("w" to "h"), copies)
        assertEquals("1 note", noteCountWords(1))
        assertEquals("Not read yet", noteCountWords(null))
    }

    @Test
    fun thePrimarysOverviewCopiesToTheOthersAndOneNotebookHasNoCopySettings() {
        val copies = mutableListOf<Pair<String, String?>>()
        val actions = GitNotebooksActions(onCopySettings = { from, to -> copies += from to to; "" })
        var rows by mutableStateOf(listOf(work))
        compose.setContent { PenmossTheme { NotebookPage(work, GitNotebooksUi(rows = rows, journal = "w"), actions, NotebookTab.OVERVIEW, onBack = {}, notes = 0) } }
        compose.onNodeWithTag("gitNoteCount-w", useUnmergedTree = true).assertTextEquals("0 notes")
        compose.onNodeWithTag("gitCopySettingsOpen-w").assertDoesNotExist()
        rows = listOf(work, home)
        compose.onNodeWithTag("gitCopySettingsOpen-w").performScrollTo().performClick()
        compose.onNodeWithTag("gitCopyFrom-shown", useUnmergedTree = true).assertTextEquals("Work ›")
        compose.onNodeWithTag("gitCopyTo-shown", useUnmergedTree = true).assertTextEquals("Home ›")
        compose.onNodeWithTag("gitCopySettings").performClick()
        compose.waitForIdle()
        // One other notebook: Every Other Notebook is that one.
        assertEquals(listOf("w" to "h"), copies)
    }
}
