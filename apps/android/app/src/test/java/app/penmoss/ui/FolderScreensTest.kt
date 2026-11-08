package app.penmoss.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performTextInput
import app.penmoss.ui.screens.FolderScreen
import app.penmoss.ui.screens.HomeScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Folders on the phone (T40 P4, NT2–NT7, NT11): sheets, dialogs, the sort menu, the breadcrumb
 * and manual reorder.
 */
@RunWith(RobolectricTestRunner::class)
class FolderScreensTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun folders() = listOf(FolderItem("a", "A"), FolderItem("b", "B"))

    private fun notes() = listOf(NoteItem("n1", "One", "", "3:42 PM"), NoteItem("n2", "Two", "", ""))

    @Test
    fun theFolderSheetOffersRenameSubfolderMoveAndDelete() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderSheet(
                    "A",
                    onRename = { events += "rename" },
                    onNewSubfolder = { events += "subfolder" },
                    onMove = { events += "move" },
                    onDelete = { events += "delete" },
                    onDismiss = { events += "dismiss" },
                )
            }
        }
        for (tag in listOf("folderAction-rename", "folderAction-subfolder", "folderAction-move", "folderAction-delete")) {
            compose.onNodeWithTag(tag).performClick()
        }
        assertEquals(listOf("rename", "subfolder", "move", "delete"), events)
    }

    @Test
    fun theFolderSheetOffersNewNoteHereFirstOnlyWhenGivenIt() {
        // T52 item 1: first in the sheet, as the sidebar's menu has it; absent without a handler.
        var withIt by mutableStateOf(false)
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderSheet(
                    "A",
                    onRename = {},
                    onNewSubfolder = {},
                    onMove = {},
                    onDelete = {},
                    onDismiss = {},
                    onNewNoteHere = if (withIt) ({ events += "new" }) else null,
                )
            }
        }
        compose.onNodeWithTag("folderAction-newNote").assertDoesNotExist()
        withIt = true
        compose.waitForIdle()
        val newNote = compose.onNodeWithTag("folderAction-newNote").fetchSemanticsNode().boundsInRoot
        val rename = compose.onNodeWithTag("folderAction-rename").fetchSemanticsNode().boundsInRoot
        assertTrue("New Note Here is above Rename", newNote.bottom <= rename.top)
        compose.onNodeWithTag("folderAction-newNote").performClick()
        assertEquals(listOf("new"), events)
    }

    /** New Folder Here opens it too, so it says New Folder, never the old New Subfolder (T53 pass, A987). */
    @Test
    fun aNewFolderIsNamedInADialogCalledNewFolder() {
        var saved: String? = null
        compose.setContent {
            PenmossTheme {
                NewFolderDialog(onConfirm = { saved = it }, onDismiss = {})
            }
        }
        compose.onNodeWithText("New Folder").assertIsDisplayed()
        compose.onAllNodesWithText("New Subfolder").assertCountEquals(0)
        compose.onNodeWithTag("folderNameField").performTextInput("Drafts")
        compose.onNodeWithTag("folderNameSave").performClick()
        assertEquals("Drafts", saved)
    }

    @Test
    fun namingAFolderNeedsAName() {
        var saved: String? = null
        compose.setContent {
            PenmossTheme {
                FolderNameDialog("New folder", onConfirm = { saved = it }, onDismiss = {})
            }
        }
        compose.onNodeWithTag("folderNameSave").assertIsNotEnabled()
        compose.onNodeWithTag("folderNameField").performTextInput("  Projects  ")
        compose.onNodeWithTag("folderNameSave").performClick()
        assertEquals("Projects", saved)
    }

    @Test
    fun deletingAFolderCountsWhatMovesUp() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderDeleteDialog("A", notes = 2, subfolders = 1, destination = "Work", onConfirm = { events += "delete" }, onDismiss = {})
            }
        }
        // The web's words since T42 (A560): subfolders go to Trash with it; notes move up.
        compose.onNodeWithText(
            "It and its subfolder will be deleted. Its 2 notes move to “Work”; no notes are deleted. You can restore it from Trash for 30 days.",
        ).assertIsDisplayed()
        compose.onNodeWithTag("folderDeleteConfirm").performClick()
        assertEquals(listOf("delete"), events)
    }

    @Test
    fun deletingAnEmptyTopLevelFolderSaysSo() {
        compose.setContent {
            PenmossTheme {
                FolderDeleteDialog("A", notes = 0, subfolders = 0, destination = null, onConfirm = {}, onDismiss = {})
            }
        }
        compose.onNodeWithText("It holds no notes. You can restore it from Trash for 30 days.").assertIsDisplayed()
    }

    @Test
    fun deletingAFolderSaysItWentToTrash() {
        assertEquals("Its note moves to the top level; no notes are deleted. You can restore it from Trash for 30 days.", folderDeleteText(1, 0, null))
        assertEquals(
            "It and its 3 subfolders will be deleted. It holds no notes. You can restore it from Trash for 30 days.",
            folderDeleteText(0, 3, "Work"),
        )
        assertEquals("Moved “Projects” to Trash. Its notes moved up.", folderDeletedMessage("Projects"))
        assertEquals("Moved the folder to Trash. Its notes moved up.", folderDeletedMessage(null))
    }

    @Test
    fun theSortMenuOffersThreeModesWithTheCurrentChecked() {
        val picked = mutableListOf<String>()
        compose.setContent {
            PenmossTheme { SortMenu(expanded = true, current = "alpha", onPick = { picked += it }, onDismiss = {}) }
        }
        for (tag in listOf("sort-manual", "sort-alpha", "sort-modified")) {
            compose.onNodeWithTag(tag).assertIsDisplayed()
        }
        compose.onNodeWithTag("sort-modified").performClick()
        assertEquals(listOf("modified"), picked)
    }

    @Test
    fun theBreadcrumbOpensTheFolderAndListsEveryLevel() {
        val opened = mutableListOf<String?>()
        compose.setContent {
            PenmossTheme {
                BreadcrumbBar(
                    path = listOf(FolderItem("p", "Projects"), FolderItem("q", "Penmoss")),
                    onOpenFolder = { opened += it },
                )
            }
        }
        // Each level isolated (T39 pass 3 review, A907): a name with a bidi override can't reorder the others.
        compose.onNodeWithText("\u2068Projects\u2069 › \u2068Penmoss\u2069").assertIsDisplayed()
        compose.onNodeWithTag("breadcrumb").performClick()
        assertEquals(listOf("q"), opened)
        // A long press lists every level; each opens its folder.
        compose.onNodeWithTag("breadcrumb").performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithTag("breadcrumbLevel-p").performClick()
        assertEquals(listOf("q", "p"), opened)
    }

    /** With no notebook known, a top-level note's crumb still says so. */
    @Test
    fun aTopLevelNoteSaysSo() {
        compose.setContent {
            PenmossTheme { BreadcrumbBar(path = emptyList(), onOpenFolder = {}) }
        }
        compose.onNodeWithText(Items.TOP_LEVEL).assertIsDisplayed()
    }

    /**
     * A top-level note's crumb names its notebook (T52, as the web's phone app bar): the default
     * notebook's current name, or a git notebook's, isolated like any other name; a tap still opens
     * the top level.
     */
    @Test
    fun aTopLevelNoteNamesItsNotebook() {
        val opened = mutableListOf<String?>()
        compose.setContent {
            PenmossTheme { BreadcrumbBar(path = emptyList(), onOpenFolder = { opened += it }, notebook = "Personal") }
        }
        compose.onNodeWithText("⁨Personal⁩").assertIsDisplayed()
        compose.onNodeWithText(Items.TOP_LEVEL).assertDoesNotExist()
        compose.onNodeWithTag("breadcrumb").performClick()
        assertEquals(listOf<String?>(null), opened)
    }

    /** A note in folders shows the folders, never the notebook's name before them. */
    @Test
    fun aNoteInFoldersShowsOnlyItsFolders() {
        compose.setContent {
            PenmossTheme { BreadcrumbBar(path = listOf(FolderItem("p", "Projects")), onOpenFolder = {}, notebook = "Personal") }
        }
        compose.onNodeWithText("⁨Projects⁩").assertIsDisplayed()
    }

    @Test
    fun reorderMovesARowWithItsActions() {
        val commits = mutableListOf<Triple<String, String?, String?>>()
        compose.setContent {
            PenmossTheme {
                ReorderList(
                    folders = folders(),
                    notes = emptyList(),
                    onCommitFolder = { id, before, after -> commits += Triple(id, before, after) },
                    onCommitNote = { _, _, _ -> },
                )
            }
        }
        // Handles for every row, in order.
        assertEquals(2, compose.onAllNodesWithTag("reorderHandle").fetchSemanticsNodes().size)
        // The first folder's Move down sends it after the second.
        customAction(0, "Move Down")
        assertEquals(listOf(Triple("a", null, "b")), commits)
        // The same row's Move up sends it before the other again.
        customAction(1, "Move Up")
        assertEquals(
            listOf(Triple("a", null, "b"), Triple("a", "b", null)),
            commits,
        )
    }

    @Test
    fun reorderMovesANoteAfterItsAnchor() {
        val commits = mutableListOf<Triple<String, String?, String?>>()
        compose.setContent {
            PenmossTheme {
                ReorderList(
                    folders = emptyList(),
                    notes = notes(),
                    onCommitFolder = { _, _, _ -> },
                    onCommitNote = { id, before, after -> commits += Triple(id, before, after) },
                )
            }
        }
        customAction(0, "Move Down")
        assertEquals(listOf(Triple("n1", null, "n2")), commits)
    }

    @OptIn(ExperimentalTestApi::class)
    private fun customAction(row: Int, label: String) {
        compose.onAllNodesWithTag("reorderRow", useUnmergedTree = true)[row]
            .performCustomAccessibilityActionWithLabel(label)
    }

    @Test
    fun homeSortsAndMakesFolders() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(),
                    folders = folders(),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onNewFolder = { events += "new" },
                    sortMode = "manual",
                    onSort = { events += "sort:$it" },
                )
            }
        }
        // Sort Order is on the notebook heading's long press (T53 item 4).
        compose.onNodeWithTag("homeFoldersTitle").performTouchInput { longClick() }
        compose.onNodeWithTag("homeSort").performClick()
        compose.onNodeWithTag("sort-alpha").performClick()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("New Folder").performClick()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("Reorder Folders").performClick()
        assertEquals(listOf("sort:alpha", "new"), events)
    }

    @Test
    fun homeBackEndsReorderMode() {
        var reordering = true
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(),
                    folders = folders(),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    reordering = reordering,
                    onReorder = { reordering = it },
                )
            }
        }
        // System Back ends the mode instead of leaving Home (T40 P4 review S6).
        compose.activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(false, reordering)
    }

    @Test
    fun folderBackEndsReorderModeFirst() {
        val events = mutableListOf<String>()
        var reordering = true
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "A",
                    folders = emptyList(),
                    notes = notes(),
                    onBack = { events += "back" },
                    onFolder = {},
                    onOpen = {},
                    reordering = reordering,
                    onReorder = { reordering = it },
                )
            }
        }
        // The top bar's Back ends the mode, staying on the folder (T40 P4 review S6).
        compose.onNodeWithContentDescription("Back").performClick()
        assertEquals(false, reordering)
        assertTrue(events.isEmpty())
        // System Back does the same, instead of leaking the mode to the next open.
        reordering = true
        compose.activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(false, reordering)
        assertTrue(events.isEmpty())
    }

    @Test
    fun homeReordersItsFolders() {
        val commits = mutableListOf<Triple<String, String?, String?>>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(),
                    folders = folders(),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    reordering = true,
                    onReorder = {},
                    onMoveFolder = { id, before, after -> commits += Triple(id, before, after) },
                )
            }
        }
        compose.onNodeWithText("Reorder Folders").assertIsDisplayed()
        compose.onNodeWithTag("reorderDone").assertIsDisplayed()
        compose.onAllNodesWithTag("reorderHandle").fetchSemanticsNodes().let {
            assertEquals(2, it.size)
        }
        customAction(0, "Move Down")
        assertEquals(listOf(Triple("a", null, "b")), commits)
    }

    @Test
    fun aFolderSortsRenamesAndDeletes() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "A",
                    folders = emptyList(),
                    notes = notes(),
                    onBack = {},
                    onFolder = {},
                    onOpen = {},
                    subtitle = "Projects",
                    sortMode = "manual",
                    onSort = { events += "sort:$it" },
                    onNewFolder = { events += "new" },
                    onRenameFolder = { events += "rename" },
                    onMoveFolderTo = { events += "moveto" },
                    onDeleteFolder = { events += "delete" },
                )
            }
        }
        compose.onNodeWithText("Projects").assertIsDisplayed()
        compose.onNodeWithTag("folderSort").performClick()
        compose.onNodeWithTag("sort-modified").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("New Folder").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("Rename Folder").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("Move to…").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("Reorder").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("Delete Folder…").performClick()
        assertEquals(listOf("sort:modified", "new", "rename", "moveto", "delete"), events)
    }
}
