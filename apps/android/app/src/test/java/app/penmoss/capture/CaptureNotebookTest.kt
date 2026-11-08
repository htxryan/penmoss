package app.penmoss.capture

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.penmoss.ui.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Which notebook a capture goes to (T50 G8, A827, A888; PR #167 review): the sheet names it and
 * lets the person change it, and it never picks the first of several git notebooks silently.
 */
@RunWith(AndroidJUnit4::class)
class CaptureNotebookTest {
    @get:Rule
    val compose = createComposeRule()

    private val work = CaptureNotebook("01JBL0000000000000000000L1", "Work")
    private val home = CaptureNotebook("01JBL0000000000000000000L2", "Home")

    @Test
    fun theSheetStartsOnThePickedJournalNotebookAndNeverOnTheFirstGitOneSilently() {
        // Several git notebooks, none picked: none, the person chooses.
        assertNull(CaptureNotebook.start(null, listOf(work, home)))
        // A pick of the personal notes, kept from before T59 (A1040): no pick.
        assertNull(CaptureNotebook.start("personal", listOf(work, home)))
        assertEquals(home.key, CaptureNotebook.start(home.key, listOf(work, home)))
        // The only place there is, named on the sheet; a picked notebook removed since: not it.
        assertEquals(work.key, CaptureNotebook.start(null, listOf(work)))
        assertNull(CaptureNotebook.start("01JBL0000000000000000000L9", listOf(work, home)))
    }

    /** With no git notebook on the phone, the sheet says to add one and opens the app (A1040). */
    @Test
    fun withNoNotebookTheSheetSaysToAddOne() {
        var opened = 0
        compose.setContent {
            PenmossTheme { CaptureScreen(CaptureUi(hasNotebook = false), onText = {}, onDestination = {}, onSave = {}, onCancel = {}, onOpenApp = { opened++ }, onNotebook = {}) }
        }
        compose.onNodeWithText(NO_NOTEBOOK).assertExists()
        compose.onNodeWithTag("captureOpenApp").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun withSeveralNotebooksTheSheetNamesTheOneChosenAndSaveWaitsForAChoice() {
        val chosen = mutableListOf<String>()
        var ui by mutableStateOf(CaptureUi(text = "Milk", notebooks = listOf(work, home), notebook = null))
        compose.setContent {
            PenmossTheme {
                CaptureScreen(ui, onText = {}, onDestination = {}, onSave = {}, onCancel = {}, onOpenApp = {}, onNotebook = {
                    chosen += it
                    ui = ui.copy(notebook = it)
                })
            }
        }
        compose.onNodeWithText("Choose a Notebook").assertIsDisplayed()
        compose.onNodeWithTag("captureSave").assertIsNotEnabled()
        compose.onNodeWithTag("captureNotebook").performClick()
        compose.onNodeWithTag("captureNotebook-${home.key}").performClick()
        assertEquals(listOf(home.key), chosen)
        compose.onNodeWithText("Into Home").assertIsDisplayed()
        compose.onNodeWithTag("captureSave").assertIsEnabled()
    }

    @Test
    fun withOneNotebookThereIsNothingToChoose() {
        compose.setContent {
            PenmossTheme { CaptureScreen(CaptureUi(text = "Milk", notebooks = listOf(work), notebook = work.key), {}, {}, {}, {}, {}) }
        }
        compose.onNodeWithTag("captureNotebook").assertDoesNotExist()
        compose.onNodeWithTag("captureSave").assertIsEnabled()
    }
}

