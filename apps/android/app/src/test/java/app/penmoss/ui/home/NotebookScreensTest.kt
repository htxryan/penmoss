package app.penmoss.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderEntity
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.folders.FolderDeleteDialog
import app.penmoss.ui.folders.FolderSheet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * A git notebook's own screens (A912): one notebook, with no notebooks inside it. Home's Notebooks
 * section is its heading and its folders, a folder's actions never turn it into a notebook, and
 * the Move sheet lists every folder, ungrouped. A folder an older row flags is a plain folder.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotebookScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val folders = listOf(
        // Flagged by an older version's row (T43): read as a folder.
        FolderEntity("w", "Work", null, "a0", "manual", notebook = true),
        FolderEntity("c", "Clients", "w", "a0", "manual"),
        FolderEntity("p", "Projects", null, "a1", "manual"),
        FolderEntity("r", "Recipes", "p", "a0", "manual"),
    )

    @Test
    fun homeListsTheNotebooksHeadingThenItsFolders() {
        val top = Items.home("manual", folders, now = 0)
        assertEquals(listOf("w", "p"), top.map { it.id })
        var opened: String? = null
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = top,
                        status = "",
                        syncing = false,
                    ),
                    HomeActions(
                        onFolder = { opened = it },
                    ),
                )
            }
        }
        compose.onNodeWithText("Notebooks").assertIsDisplayed()
        compose.onNodeWithTag("homeFoldersTitle").assertIsDisplayed()
        compose.onNodeWithText("Personal").assertIsDisplayed()
        // The notes' sync dot is on their heading, as the web's Personal (T51, A933), never on Notebooks.
        compose.onAllNodes(hasTestTag("syncDot") and hasAnyAncestor(hasTestTag("homeFoldersTitle")), useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithTag("homeNotebooksTitle").assertTextEquals("Notebooks")
        compose.onAllNodes(hasTestTag("syncDot") and hasAnyAncestor(hasTestTag("homeNotebooksTitle")), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("syncDot", useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithText("Work").performClick()
        assertEquals("w", opened)
        // No New Notebook in a git notebook (A912).
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeNewFolder").assertIsDisplayed()
        compose.onNodeWithTag("homeNewNotebook").assertDoesNotExist()
    }

    /**
     * T39 pass 3 review (A912): a git notebook is one notebook, so a top-level folder's menu and
     * sheet offer Move but never Turn into notebook, and nothing offers Close.
     */
    @Test
    fun aTopLevelFoldersSheetAndMenuOfferNoTurnIntoNotebook() {
        var step by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                if (step == 0) {
                    FolderScreen(title = "Projects", folders = emptyList(), notes = emptyList(), onBack = {}, onFolder = {}, onOpen = {})
                } else {
                    FolderSheet("Projects", onRename = {}, onNewSubfolder = {}, onMove = {}, onDelete = {}, onDismiss = {})
                }
            }
        }
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithTag("folderMoveTo").assertIsDisplayed()
        compose.onNodeWithTag("folderTurnIntoNotebook").assertDoesNotExist()
        compose.onNodeWithTag("folderTurnBack").assertDoesNotExist()
        step = 1
        compose.onNodeWithTag("folderAction-move").assertIsDisplayed()
        compose.onNodeWithTag("folderAction-turnIntoNotebook").assertDoesNotExist()
        compose.onNodeWithTag("folderAction-turnBack").assertDoesNotExist()
        compose.onNodeWithTag("folderAction-close").assertDoesNotExist()
    }

    /** T39 pass 3 (A891): the web's names, with "…" where something asks first. */
    @Test
    fun theFolderSheetAndTheDeleteQuestionUseTheWebsNames() {
        val ran = mutableListOf<String>()
        var step by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                when (step) {
                    0 -> FolderSheet("Projects", onRename = {}, onNewSubfolder = {}, onMove = {}, onDelete = { ran += "delete" }, onDismiss = {})
                    else -> FolderDeleteDialog("Projects", notes = 2, subfolders = 0, destination = null, onConfirm = { ran += "folder" }, onDismiss = {})
                }
            }
        }
        compose.onNodeWithText("Delete Folder…").performClick()
        step = 1
        compose.onNodeWithTag("folderDeleteConfirm").assertTextEquals("Delete Folder").performClick()
        assertEquals(listOf("delete", "folder"), ran)
    }

    /** The Move sheet lists every folder, ungrouped, and a folder an older row flags may move anywhere. */
    @Test
    fun theMoveSheetListsEveryFolderUngrouped() {
        assertEquals(listOf(null, "w", "c", "p", "r"), Items.folderChoices("manual", folders).map { it.id })
        // Only the folder itself and what is inside it are left out.
        assertEquals(listOf(null, "p", "r"), Items.folderChoicesExcluding("manual", folders, "w").map { it.id })
        assertTrue(Items.folderChoicesExcluding("manual", folders, "p").any { it.id == "w" })
    }
}
