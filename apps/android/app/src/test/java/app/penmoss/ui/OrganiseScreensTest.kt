package app.penmoss.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderEntity
import app.penmoss.editor.NewNoteRequest
import app.penmoss.engine.notes.Tags
import app.penmoss.ui.screens.AllNotesScreen
import app.penmoss.ui.screens.FolderScreen
import app.penmoss.ui.screens.HomeScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The folder picker, the tag sheet and New note in a folder (T38), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OrganiseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val folders = listOf(
        FolderEntity("home", "Home", null, "a1", "manual"),
        FolderEntity("work", "Work", null, "a0", "alpha"),
        FolderEntity("garden", "Garden", "home", "a0", "manual"),
        FolderEntity("beds", "Raised beds", "garden", "a0", "manual"),
        FolderEntity("zeta", "Zeta", "work", "a0", "manual"),
        FolderEntity("alpha", "Alpha", "work", "a9", "manual"),
    )

    private val choices = Items.folderChoices("manual", folders)

    @Test
    fun thePickerListsTheTopLevelThenTheNestedTreeInEachFoldersOrder() {
        // Work sorts alphabetically, so Alpha comes before Zeta whatever their positions.
        assertEquals(
            listOf(null to 0, "work" to 0, "alpha" to 1, "zeta" to 1, "home" to 0, "garden" to 1, "beds" to 2),
            choices.map { it.id to it.depth },
        )
        assertEquals("Top level", choices.first().name)
    }

    @Test
    fun thePickerMarksWhereTheNoteIsAndPicksAnyFolderOrTheTopLevel() {
        val picked = mutableListOf<String?>()
        var open by mutableStateOf(true)
        compose.setContent {
            PenmossTheme {
                if (open) {
                    FolderPickerSheet(
                        "Move “Soup” to…",
                        choices,
                        current = "garden",
                        onPick = {
                            picked += it
                            open = false
                        },
                        onDismiss = { open = false },
                    )
                }
            }
        }
        compose.onNodeWithText("Move “Soup” to…").assertIsDisplayed()
        compose.onNodeWithTag("folderChoice:garden").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        compose.onNodeWithTag("folderChoice:beds").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        compose.onNodeWithText("Raised beds").performClick()
        assertEquals(listOf<String?>("beds"), picked)
        open = true
        compose.onNodeWithText("Top level").performClick()
        assertEquals(listOf<String?>("beds", null), picked)
    }

    @Test
    fun theTagSheetShowsRemovesAndAddsTagsWithSuggestions() {
        val events = mutableListOf<String>()
        var tags by mutableStateOf<List<String>?>(listOf("soup"))
        compose.setContent {
            PenmossTheme {
                TagSheet(
                    tags = tags,
                    editable = true,
                    known = listOf("area/cooking" to 9, "cooking" to 2, "soup" to 4, "inbox" to 20),
                    onAdd = { events += "add:$it" },
                    onRemove = { events += "remove:$it" },
                    onDismiss = {},
                )
            }
        }
        compose.onNodeWithText("#soup").assertIsDisplayed()
        // With nothing typed, the most used tags the note lacks.
        compose.onNodeWithTag("suggestion:inbox").assertIsDisplayed()
        compose.onNodeWithTag("suggestion:soup").assertDoesNotExist()
        // The whole chip removes the tag, and says so to TalkBack (T38 review).
        compose.onNodeWithTag("tag:soup").assert(SemanticsMatcher("removes") { it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Remove the Tag" })
        compose.onNodeWithTag("tag:soup").performClick()
        // Suggestions follow what is typed, those starting with it first.
        compose.onNodeWithTag("tagField").performTextInput("cook")
        compose.onNodeWithTag("suggestion:inbox").assertDoesNotExist()
        compose.onNodeWithTag("suggestion:cooking").performClick()
        // A new tag, typed as the person likes: normalised as the web does.
        compose.onNodeWithTag("tagField").performTextInput("#Area/Dinner")
        compose.onNodeWithTag("tagField").performImeAction()
        assertEquals(listOf("remove:soup", "add:cooking", "add:area/dinner"), events)
        // The page says what the note now holds.
        tags = listOf("area/dinner", "cooking")
        compose.onNodeWithTag("tag:cooking").assertIsDisplayed()
        compose.onNodeWithTag("tag:soup").assertDoesNotExist()
    }

    @Test
    fun aNameThatIsNotATagIsRefusedWithTheWebsWords() {
        val added = mutableListOf<String>()
        compose.setContent {
            PenmossTheme { TagSheet(listOf(), editable = true, known = emptyList(), onAdd = { added += it }, onRemove = {}, onDismiss = {}) }
        }
        compose.onNodeWithTag("noTags").assertIsDisplayed()
        compose.onNodeWithTag("tagField").performTextInput("two words")
        compose.onNodeWithText("Add").performClick()
        // Under the field, as the web says it.
        compose.onNodeWithTag("tagError", useUnmergedTree = true).assertIsDisplayed().assertTextEquals(Tags.INVALID)
        assertEquals(emptyList<String>(), added)
    }

    @Test
    fun aReadOnlyNoteShowsItsTagsOnly() {
        compose.setContent {
            PenmossTheme {
                TagSheet(listOf("soup"), editable = false, known = listOf("inbox" to 1), onAdd = {}, onRemove = {}, onDismiss = {})
            }
        }
        compose.onNodeWithText("#soup").assertIsDisplayed()
        // Shown, with nothing to press.
        compose.onNodeWithTag("tag:soup").assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        compose.onNodeWithTag("tagField").assertDoesNotExist()
        compose.onNodeWithTag("suggestion:inbox").assertDoesNotExist()
        compose.onNodeWithText("This note can't be changed here", substring = true).assertIsDisplayed()
    }

    @Test
    fun aTagLongerThanThePhoneSendsIsShownButNotOfferedForRemoval() {
        val long = "a" + "b".repeat(Tags.MAX_CHARS)
        compose.setContent {
            PenmossTheme { TagSheet(listOf(long, "soup"), editable = true, known = emptyList(), onAdd = {}, onRemove = {}, onDismiss = {}) }
        }
        compose.onNodeWithTag("tag:$long").assertExists().assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        compose.onNodeWithTag("tag:soup").assertHasClickAction()
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp")
    fun thePickerNamesEachFoldersParentAndKeepsDeepFoldersReadable() {
        // A chain twelve folders deep.
        val deep = (1..12).map { FolderEntity("l$it", "Level $it", if (it == 1) null else "l${it - 1}", if (it == 1) "z9" else "a0", "manual") }
        val deepChoices = Items.folderChoices("manual", folders + deep)
        compose.setContent {
            PenmossTheme { FolderPickerSheet("Move to…", deepChoices, current = null, onPick = {}, onDismiss = {}) }
        }
        // Two folders of the same name are told apart: TalkBack hears the parent.
        compose.onNodeWithTag("folderChoice:beds").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "in Garden"))
        compose.onNodeWithTag("folderChoice:home").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))
        // Selected once, not also by the tick's own words.
        compose.onNodeWithTag("folderChoice:top").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        compose.onNodeWithContentDescription("Current").assertDoesNotExist()
        // Indented up to six levels: deeper folders start where the sixth does.
        compose.onNodeWithTag("folderPicker").performScrollToNode(hasText("Level 12"))
        // The name's own node (the row merges it): where its text starts.
        val left = { name: String -> compose.onNodeWithText(name, useUnmergedTree = true).getUnclippedBoundsInRoot().left }
        assertEquals(left("Level 6"), left("Level 12"))
        assertTrue(left("Level 5") < left("Level 6"))
    }

    @Test
    fun aFoldersLastNoteScrollsClearOfTheNewNoteButton() {
        val many = (1..30).map { NoteItem("n$it", "Note $it", "", "") }
        compose.setContent {
            PenmossTheme { FolderScreen("Garden", emptyList(), many, onBack = {}, onFolder = {}, onOpen = {}, onNewNote = {}) }
        }
        compose.onNodeWithTag("noteList").performScrollToIndex(many.lastIndex)
        compose.waitForIdle()
        val last = compose.onNodeWithText("Note 30").getUnclippedBoundsInRoot()
        val button = compose.onNodeWithContentDescription("New Note in This Folder").getUnclippedBoundsInRoot()
        assertTrue("the last note (${last.bottom}) is under the button (${button.top})", last.bottom <= button.top)
    }

    @Test
    fun aDoubleTapOnNewNoteMakesOneNewNote() {
        lateinit var nav: NavHostController
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "folder") {
                    composable("folder") {
                        FolderScreen("Garden", emptyList(), emptyList(), onBack = {}, onFolder = {}, onOpen = {}, onNewNote = { nav.startNewNote("garden") })
                    }
                    composable(NOTE_ROUTE, arguments = noteArguments) { entry -> Text(if (newNoteRequest(entry) != null) "Making" else "Opening") }
                }
            }
        }
        // Two taps before the new note's screen shows (the clock held, as on a slow phone).
        compose.mainClock.autoAdvance = false
        compose.onNodeWithContentDescription("New Note in This Folder").performClick()
        compose.onNodeWithContentDescription("New Note in This Folder").performClick()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        val newNotes = nav.currentBackStack.value.filter { it.destination.route == NOTE_ROUTE }
        assertEquals(1, newNotes.size)
        assertEquals(NewNoteRequest("garden"), newNoteRequest(newNotes.single()))
        compose.onNodeWithText("Making").assertIsDisplayed()
    }

    @Test
    fun aFoldersLongPressOffersNewNoteHereWhichMakesANoteInThatFolder() {
        // T52 item 1: the sidebar's right-click New Note Here, as the folder sheet's first action.
        lateinit var nav: NavHostController
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "home") {
                    composable("home") {
                        FolderSheet(
                            "Garden",
                            onRename = {},
                            onNewSubfolder = {},
                            onMove = {},
                            onDelete = {},
                            onDismiss = {},
                            onNewNoteHere = { nav.startNewNote("garden") },
                        )
                    }
                    composable(NOTE_ROUTE, arguments = noteArguments) { entry -> Text(if (newNoteRequest(entry) != null) "Making" else "Opening") }
                }
            }
        }
        compose.onNodeWithTag("folderAction-newNote").assertTextEquals("New Note Here").performClick()
        compose.waitForIdle()
        val made = nav.currentBackStack.value.single { it.destination.route == NOTE_ROUTE }
        assertEquals(NewNoteRequest("garden"), newNoteRequest(made))
        compose.onNodeWithText("Making").assertIsDisplayed()
    }

    @Test
    fun aNewNotesScreenComeBackToNeverMakesItsNoteAgain() {
        lateinit var nav: NavHostController
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "home") {
                    composable("home") { Text("Home") }
                    composable("other") { Text("Elsewhere") }
                    composable(NOTE_ROUTE, arguments = noteArguments) { entry ->
                        Column {
                            Text(if (newNoteRequest(entry) != null) "Making" else "Opening")
                            Button(onClick = entry::markNoteMade) { Text("Made") }
                        }
                    }
                }
            }
        }
        compose.runOnUiThread { nav.startNewNote(null) }
        compose.onNodeWithText("Making").assertIsDisplayed()
        compose.onNodeWithText("Made").performClick()
        // Ryan opens a link and comes back: the note is made already (or deleted for good since).
        compose.runOnUiThread { nav.navigate("other") }
        compose.onNodeWithText("Elsewhere").assertIsDisplayed()
        compose.runOnUiThread { nav.popBackStack() }
        compose.onNodeWithText("Opening").assertIsDisplayed()
        compose.onNodeWithText("Making").assertDoesNotExist()
    }

    @Test
    fun aFolderMakesNewNotesInItselfOrOffersAnotherFolder() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "Garden",
                    folders = emptyList(),
                    notes = listOf(NoteItem("p", "Plan", "", "")),
                    onBack = {},
                    onFolder = {},
                    onOpen = {},
                    onNewNote = { events += "new here" },
                    onNewNoteIn = { events += "pick" },
                    onNoteLongPress = { events += "move:${it.id}" },
                )
            }
        }
        compose.onNodeWithContentDescription("New Note in This Folder").performClick()
        compose.onNodeWithContentDescription("More Options").performClick()
        compose.onNodeWithText("New Note in…").performClick()
        compose.onNodeWithText("Plan").performTouchInput { longClick() }
        assertEquals(listOf("new here", "pick", "move:p"), events)
    }

    @Test
    fun aLongPressOnANoteInAnyListOffersToMoveIt() {
        val moved = mutableListOf<String>()
        val opened = mutableListOf<String>()
        var screen by mutableStateOf("home")
        compose.setContent {
            PenmossTheme {
                if (screen == "home") {
                    HomeScreen(
                        recent = listOf(NoteItem("n1", "Groceries", "", "")),
                        folders = emptyList(),
                        status = "",
                        syncing = false,
                        onSearch = {},
                        onSettings = {},
                        onAllNotes = {},
                        onFolder = {},
                        onOpen = { opened += it },
                        onToday = {},
                        onNewNote = {},
                        onNoteLongPress = { moved += it.id },
                    )
                } else {
                    AllNotesScreen(listOf(NoteItem("n2", "Taxes", "", "")), onBack = {}, onOpen = { opened += it }, onNoteLongPress = { moved += it.id })
                }
            }
        }
        compose.onNodeWithText("Groceries").performTouchInput { longClick() }
        screen = "all"
        compose.onNodeWithText("Taxes").performTouchInput { longClick() }
        compose.onNodeWithText("Taxes").performClick()
        assertEquals(listOf("n1", "n2"), moved)
        assertEquals(listOf("n2"), opened)
    }

    @Test
    fun aNewNotesRouteNamesItsFolder() {
        assertEquals("note/01ABC?new=true", newNoteRoute("01ABC", null))
        assertEquals("note/01ABC?new=true&folder=01F", newNoteRoute("01ABC", "01F"))
        compose.setContent { PenmossTheme { NoteList(listOf(NoteItem("a", "A", "", "")), onOpen = {}) } }
        // A list given no long-press action offers none.
        compose.onNode(hasText("A") and hasClickAction()).assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnLongClick))
    }
}
