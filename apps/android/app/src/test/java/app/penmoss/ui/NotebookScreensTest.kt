package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteEntity
import app.penmoss.data.Notebooks
import app.penmoss.data.TrashRow
import app.penmoss.engine.api.NotebookRef
import app.penmoss.engine.api.TrashListed
import app.penmoss.engine.api.TrashedFolderListed
import app.penmoss.ui.screens.FolderScreen
import app.penmoss.ui.screens.HomeScreen
import androidx.compose.ui.test.assertTextEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Notebooks on the phone's screens (T43, A750–A760): Home's Notebooks at the top, a notebook's
 * actions, the Move sheet grouped by notebook, Settings → Notebooks and Trash.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotebookScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val folders = listOf(
        FolderEntity("w", "Work", null, "a0", "manual", notebook = true),
        FolderEntity("c", "Clients", "w", "a0", "manual"),
        FolderEntity("p", "Projects", null, "a1", "manual"),
        FolderEntity("r", "Recipes", "p", "a0", "manual"),
        FolderEntity("i", "Ideas", null, "a2", "manual", notebook = true),
        FolderEntity(Notebooks.JOURNAL_FOLDER, "Journal", null, "a3", "manual"),
    )

    @Test
    fun homeListsTheOpenNotebooksFirstThenTheDefaultNotebooksFolders() {
        val (notebooks, top) = Items.home("manual", folders, closed = setOf("i"), now = 0)
        assertEquals(listOf("w"), notebooks.map { it.id })
        assertEquals(listOf("p", Notebooks.JOURNAL_FOLDER), top.map { it.id })
        // Projects may become a notebook; Journal may not.
        assertEquals(listOf(true, false), top.map { it.canBeNotebook })
        var opened: String? = null
        var newNotebook = 0
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(), folders = top, status = "", syncing = false,
                    onSearch = {}, onSettings = {}, onAllNotes = {}, onFolder = { opened = it }, onOpen = {}, onToday = {}, onNewNote = {},
                    notebooks = notebooks, defaultNotebook = "Home", onNewNotebook = { newNotebook++ },
                )
            }
        }
        compose.onNodeWithText("Notebooks").assertIsDisplayed()
        compose.onNodeWithTag("homeFoldersTitle").assertIsDisplayed()
        compose.onNodeWithText("Home").assertIsDisplayed()
        // The personal notes' sync dot is on their heading, as the web's Personal (T51, A933), never on Notebooks.
        compose.onAllNodes(hasTestTag("syncDot") and hasAnyAncestor(hasTestTag("homeFoldersTitle")), useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithTag("homeNotebooksTitle").assertTextEquals("Notebooks")
        compose.onAllNodes(hasTestTag("syncDot") and hasAnyAncestor(hasTestTag("homeNotebooksTitle")), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("syncDot", useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithText("Work").performClick()
        assertEquals("w", opened)
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeNewNotebook").performClick()
        assertEquals(1, newNotebook)
    }

    @Test
    fun aNotebooksSheetOffersTurnBackAndDeleteNeverMove() {
        val ran = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderSheet(
                    "Work", onRename = { ran += "rename" }, onNewSubfolder = {}, onMove = { ran += "move" }, onDelete = { ran += "delete" }, onDismiss = {},
                    notebook = true, onTurnBack = { ran += "back" },
                )
            }
        }
        compose.onNodeWithTag("folderAction-move").assertDoesNotExist()
        compose.onNodeWithTag("folderAction-turnIntoNotebook").assertDoesNotExist()
        compose.onNodeWithText("Turn Back into a Folder…").performClick()
        compose.onNodeWithText("Delete Notebook…").performClick()
        assertEquals(listOf("back", "delete"), ran)
    }

    @Test
    fun aTopLevelFoldersSheetAndMenuOfferTurnIntoNotebook() {
        var turned = 0
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "Projects", folders = emptyList(), notes = emptyList(), onBack = {}, onFolder = {}, onOpen = {},
                    onTurnIntoNotebook = { turned++ },
                )
            }
        }
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithTag("folderMoveTo").assertIsDisplayed()
        compose.onNodeWithTag("folderTurnIntoNotebook").performClick()
        assertEquals(1, turned)
    }

    @Test
    fun aNotebooksMenuRenamesTurnsBackAndDeletesTheNotebook() {
        val ran = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "Work", folders = emptyList(), notes = emptyList(), onBack = {}, onFolder = {}, onOpen = {},
                    notebook = true, onTurnBack = { ran += "back" }, onDeleteFolder = { ran += "delete" },
                )
            }
        }
        compose.onNodeWithText("This notebook is empty.").assertIsDisplayed()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithTag("folderMoveTo").assertDoesNotExist()
        compose.onNodeWithText("Rename Notebook").assertIsDisplayed()
        compose.onNodeWithTag("folderTurnBack").performClick()
        compose.onNodeWithTag("folderMore").performClick()
        compose.onNodeWithText("Delete Notebook…").performClick()
        assertEquals(listOf("back", "delete"), ran)
    }

    @Test
    fun theDialogsSayWhatHappensToTheNotes() {
        assertEquals("Its 3 notes go to Trash with it. You can restore the notebook, notes and all, from Trash for 30 days.", notebookDeleteText(3))
        assertEquals("Its note goes to Trash with it. You can restore the notebook, notes and all, from Trash for 30 days.", notebookDeleteText(1))
        // Its notes join the default notebook; nothing is deleted (T43 review S6), never "no more changes".
        assertEquals("It becomes a folder in Home. Its notes join Home and show wherever Home is open. Nothing is deleted.", notebookTurnBackText("Home"))
        assertTrue(!notebookTurnBackText("Home").contains("no more changes"))
        var deleted = 0
        compose.setContent { PenmossTheme { NotebookDeleteDialog("Work", 3, onConfirm = { deleted++ }, onDismiss = {}) } }
        compose.onNodeWithText("Its 3 notes go to Trash with it. You can restore the notebook, notes and all, from Trash for 30 days.").assertIsDisplayed()
        compose.onNodeWithTag("notebookDeleteConfirm").performClick()
        assertEquals(1, deleted)
    }

    /** T39 pass 3 (A897): a notebook closes from its sheet, and Settings → Notebooks makes one, as on the web. */
    @Test
    fun aNotebookClosesFromItsSheetAndSettingsMakesANewOne() {
        val ran = mutableListOf<String>()
        var step by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                if (step == 0) {
                    FolderSheet("Work", onRename = {}, onNewSubfolder = {}, onMove = {}, onDelete = {}, onDismiss = {}, notebook = true, onClose = { ran += "close" })
                } else {
                    NotebooksScreen(
                        rows = listOf(NotebookRowUi(app.penmoss.data.Notebooks.DEFAULT, "Personal", open = true)),
                        defaultName = "Personal", onOpen = { _, _ -> }, onRenameDefault = {}, onBack = {},
                        onNewNotebook = { ran += "new $it" },
                    )
                }
            }
        }
        compose.onNodeWithText("Close on This Phone").performClick()
        step = 1
        compose.onNodeWithTag("settingsNewNotebook").performScrollTo().performClick()
        compose.onNodeWithTag("folderNameField").performTextInput("Recipes")
        compose.onNodeWithTag("folderNameSave").performClick()
        assertEquals(listOf("close", "new Recipes"), ran)
        assertEquals("Closed “Work” on this phone. Open it again in Settings → Notebooks.", notebookClosedMessage("Work"))
    }

    /** T39 pass 3 (A891): the web's names, with "…" where something asks first. */
    @Test
    fun theFolderSheetAndTheTurnBackQuestionUseTheWebsNames() {
        val ran = mutableListOf<String>()
        var step by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                when (step) {
                    0 -> FolderSheet("Projects", onRename = {}, onNewSubfolder = {}, onMove = {}, onDelete = { ran += "delete" }, onDismiss = {})
                    1 -> NotebookTurnBackDialog("Work", "Personal", onConfirm = { ran += "back" }, onDismiss = {})
                    else -> FolderDeleteDialog("Projects", notes = 2, subfolders = 0, destination = null, onConfirm = { ran += "folder" }, onDismiss = {})
                }
            }
        }
        compose.onNodeWithText("Delete Folder…").performClick()
        step = 1
        compose.onNodeWithTag("notebookTurnBackConfirm").assertTextEquals("Turn into a Folder").performClick()
        step = 2
        compose.onNodeWithTag("folderDeleteConfirm").assertTextEquals("Delete Folder").performClick()
        assertEquals(listOf("delete", "back", "folder"), ran)
    }

    @Test
    fun theMoveSheetGroupsDestinationsByNotebook() {
        val choices = Items.folderChoices("manual", folders, "Home")
        assertEquals(
            listOf(null to "Home", "p" to "Home", "r" to "Home", Notebooks.JOURNAL_FOLDER to "Home", "w" to "Work", "c" to "Work", "i" to "Ideas"),
            choices.map { it.id to it.group },
        )
        assertEquals(listOf("w", "i"), choices.filter { it.notebook }.map { it.id })
        // A notebook moves nowhere; Journal never into a notebook.
        assertEquals(listOf(null), Items.folderChoicesExcluding("manual", folders, "w", "Home").map { it.id })
        assertEquals(listOf(null, "p", "r"), Items.folderChoicesExcluding("manual", folders, Notebooks.JOURNAL_FOLDER, "Home").map { it.id })
        // No notebooks: the list as before, ungrouped.
        assertTrue(Items.folderChoices("manual", folders.map { it.copy(notebook = false) }).all { it.group == null })

        var picked: String? = "none"
        compose.setContent { PenmossTheme { FolderPickerSheet("Move “Plan” to…", choices, current = "p", onPick = { picked = it }, onDismiss = {}) } }
        compose.onNodeWithTag("folderGroup:Home").assertIsDisplayed()
        compose.onNodeWithTag("folderPicker").performScrollToNode(hasText("Clients"))
        compose.onNodeWithTag("folderGroup:Work").assertIsDisplayed()
        compose.onNodeWithTag("folderChoice:c").performClick()
        assertEquals("c", picked)
    }

    /**
     * Everything in Journal or the Inbox stays in the default notebook, at any depth (T43 review
     * S4): the Move sheet offers a year folder no notebook, and the rule refuses one, as core does.
     */
    @Test
    fun aFolderInsideJournalOrTheInboxIsOfferedNoNotebook() {
        val year = FolderEntity("y", "2026", Notebooks.JOURNAL_FOLDER, "a0", "manual")
        val month = FolderEntity("m", "October", "y", "a0", "manual")
        val inbox = FolderEntity(Notebooks.INBOX_FOLDER, "Inbox", null, "a4", "manual")
        val clipped = FolderEntity("k", "Clipped", Notebooks.INBOX_FOLDER, "a0", "manual")
        val all = folders + year + month + inbox + clipped
        assertEquals(listOf(null, "p", "r", Notebooks.JOURNAL_FOLDER, Notebooks.INBOX_FOLDER, "k"), Items.folderChoicesExcluding("manual", all, "y", "Home").map { it.id })
        assertEquals(listOf(null, "p", "r", Notebooks.JOURNAL_FOLDER, "y", "m", Notebooks.INBOX_FOLDER), Items.folderChoicesExcluding("manual", all, "k", "Home").map { it.id })
        for (id in listOf("y", "m", "k")) {
            assertEquals(Notebooks.JOURNAL_STAYS, Notebooks.moveRefusal(all, id, "w"))
            assertEquals(Notebooks.JOURNAL_STAYS, Notebooks.moveRefusal(all, id, "c"))
            assertNull(Notebooks.moveRefusal(all, id, "p"))
        }
        assertTrue(Notebooks.staysInDefault(all, "m"))
        // A plain folder still may go into a notebook.
        assertNull(Notebooks.moveRefusal(all, "r", "w"))
        assertTrue(Items.folderChoicesExcluding("manual", all, "r", "Home").any { it.id == "w" })
    }

    @Test
    fun settingsOpensAndClosesEachNotebookButNeverTheDefault() {
        val rows = notebookRows(folders, closed = setOf("i"), defaultName = "Home")
        assertEquals(listOf(Notebooks.DEFAULT to true, "w" to true, "i" to false), rows.map { it.id to it.open })
        assertEquals("Home and 1 of 2 notebooks open on this phone", notebooksSummary("Home", 2, 1))
        assertEquals("Personal · no other notebooks", notebooksSummary("Personal", 0, 0))
        val changes = mutableListOf<Pair<String, Boolean>>()
        var renamed: String? = null
        compose.setContent {
            PenmossTheme { NotebooksScreen(rows, "Home", onOpen = { id, open -> changes += id to open }, onRenameDefault = { renamed = it }, onBack = {}) }
        }
        compose.onNodeWithTag("notebookOpen-default").assertIsOn().assertIsNotEnabled()
        compose.onNodeWithTag("notebookOpen-i").assertIsOff().performClick()
        compose.onNodeWithTag("notebookOpen-w").performClick()
        assertEquals(listOf("i" to true, "w" to false), changes)
        compose.onNodeWithTag("renameDefaultNotebook").performScrollTo().performClick()
        compose.onNodeWithTag("defaultNotebookField").performTextReplacement("Life")
        compose.onNodeWithTag("defaultNotebookSave").performClick()
        assertEquals("Life", renamed)
    }

    @Test
    fun trashListsANotebookWithItsNotesRatherThanEachNote() {
        val local = listOf(
            TrashRow("n1", "Plan", 10, NoteEntity.TRASH_WITH_NOTEBOOK, 5),
            TrashRow("n9", "Lone", 10, 0, 0),
        )
        val remote = listOf(TrashListed("n2", "Acme", 5, withNotebook = true), TrashListed("n8", "Other", 6))
        assertEquals(listOf("n8", "n9"), trashEntries(local, remote, now = 100).map { it.id }.sorted())
        assertEquals("Notebook · 4 notes", folderContents(TrashedFolderListed("w", "Work", notebook = true, notes = 4)))
        assertEquals("4 notes", folderContents(TrashedFolderListed("p", "Projects", notes = 4)))
    }

    /**
     * T39 pass 3 review (A912): a git notebook is one notebook, with no Settings → Notebooks to open
     * a closed one again, so its folders offer neither Turn into notebook nor Close.
     */
    @Test
    fun aGitNotebooksFoldersOfferNoNotebookActions() {
        val top = FolderItem("t", "Ideas", canBeNotebook = true)
        val work = FolderItem("w", "Work", notebook = true)
        assertEquals(NotebookOffers(turnInto = true, close = false), notebookOffers(top, git = false))
        assertEquals(NotebookOffers(turnInto = false, close = true), notebookOffers(work, git = false))
        assertEquals(NotebookOffers(turnInto = false, close = false), notebookOffers(top, git = true))
        assertEquals(NotebookOffers(turnInto = false, close = false), notebookOffers(work, git = true))
    }

    @Test
    fun theNoteScreenNamesANotebookButNotTheDefault() {
        assertEquals("Work", noteNotebookName(folders, "c"))
        assertNull(noteNotebookName(folders, "r"))
        assertNull(noteNotebookName(folders, null))
    }
}
