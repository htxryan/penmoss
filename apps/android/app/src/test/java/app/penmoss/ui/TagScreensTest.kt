package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.notes.TagTree
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.IOException

/** The tag browser, a tag's notes, and rename or merge (T40 P6, TG1–TG3), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TagScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val tree = TagTree.build(listOf(listOf("area/cooking", "soup"), listOf("area/garden"), listOf("soup")))

    @Test
    fun listsTagsNestedWithCountsAndOpensOrRenamesOne() {
        val opened = mutableListOf<String>()
        val renamed = mutableListOf<String>()
        compose.setContent { PenmossTheme { TagsScreen(tree, onBack = {}, onOpenTag = { opened += it }, onRename = { renamed += it }) } }
        // A parent counts each note under it once; its children wait until it is opened.
        compose.onNodeWithContentDescription("#area, 2 notes").assertIsDisplayed()
        compose.onNodeWithContentDescription("#soup, 2 notes").assertIsDisplayed()
        compose.onNodeWithTag("tag-area/cooking").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expand #area").performClick()
        compose.onNodeWithContentDescription("#area/cooking, 1 note").assertIsDisplayed()
        compose.onNodeWithText("#cooking").assertIsDisplayed()
        compose.onNodeWithTag("tag-area/cooking").performClick()
        compose.onNodeWithTag("tag-soup").performTouchInput { longClick() }
        compose.onNodeWithContentDescription("Collapse #area").performClick()
        compose.onNodeWithTag("tag-area/cooking").assertDoesNotExist()
        assertEquals(listOf("area/cooking"), opened)
        assertEquals(listOf("soup"), renamed)
    }

    @Test
    fun saysHowToMakeATagWhenThereIsNone() {
        compose.setContent { PenmossTheme { TagsScreen(emptyList(), onBack = {}, onOpenTag = {}, onRename = {}, status = "Renamed #a to #b in 2 notes") } }
        compose.onNodeWithText("No tags").assertIsDisplayed()
        compose.onNodeWithTag("tagStatus").assertIsDisplayed()
    }

    @Test
    fun aTagsNotesNameTheTagAndCountThem() {
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                TaggedNotesScreen("area", listOf(NoteItem("n2", "Pasta", "", "Today"), NoteItem("n1", "Peas", "", "Monday")), onBack = {}, onOpen = { opened += it })
            }
        }
        compose.onNodeWithText("#area").assertIsDisplayed()
        compose.onNodeWithText("2 notes").assertIsDisplayed()
        compose.onNodeWithText("Pasta").performClick()
        assertEquals(listOf("n2"), opened)
    }

    @Test
    fun aTagWithNoNotesSaysSo() {
        compose.setContent { PenmossTheme { TaggedNotesScreen("gone", emptyList(), onBack = {}, onOpen = {}) } }
        compose.onNodeWithText("No notes use this tag.").assertIsDisplayed()
        compose.onNodeWithText("0 notes").assertIsDisplayed()
    }

    @Test
    fun checksTheNewNameAsTheWebDoesAndSaysWhatARenameDid() {
        val known = setOf("soup", "area/cooking")
        assertEquals(TagRenameCheck.Ready("stew", merge = false), checkTagRename("soup", " #Stew ", known))
        assertEquals(TagRenameCheck.Ready("area/cooking", merge = true), checkTagRename("soup", "area/cooking", known))
        assertEquals(TagRenameCheck.Same, checkTagRename("soup", "#SOUP", known))
        assertEquals(TagRenameCheck.Invalid("A tag is letters, digits, - and _, with / for levels, and no spaces."), checkTagRename("soup", "two words", known))
        assertEquals(TagRenameCheck.Invalid("#soup cannot move inside itself."), checkTagRename("soup", "soup/hot", known))
        assertEquals("Renamed #soup to #stew in 1 note", tagRenamedMessage("soup", "stew", merge = false, notes = 1))
        assertEquals("Merged #soup into #area/cooking in 3 notes", tagRenamedMessage("soup", "area/cooking", merge = true, notes = 3))
        assertEquals("A tag cannot move inside itself", tagRenameError(ApiException(400, "invalid_request", "A tag cannot move inside itself")))
        assertEquals("Renaming a tag needs a connection. Try again when you are online.", tagRenameError(IOException("offline")))
    }

    @Test
    fun renamesOrSaysItMergesAndShowsWhyTheServerRefused() {
        val asked = mutableListOf<Pair<String, Boolean>>()
        var answer: String? = "#soup is in 6000 notes; one rename covers at most 5000"
        val done = mutableListOf<String?>()
        compose.setContent {
            PenmossTheme {
                RenameTagDialog(
                    "soup",
                    known = setOf("soup", "stew"),
                    unsent = 0,
                    onRename = { to, merge ->
                        asked += to to merge
                        answer
                    },
                    onSyncNow = {},
                    onDone = { done += it },
                )
            }
        }
        compose.onNodeWithTag("tagRenameField").performTextClearance()
        compose.onNodeWithTag("tagRenameField").performTextInput("stew")
        compose.onNodeWithText("#stew exists: its notes and these will share it.").assertIsDisplayed()
        compose.onNodeWithText("Merge").performClick()
        compose.onNodeWithTag("tagRenameError").assertIsDisplayed()
        compose.onNodeWithTag("tagRenameField").performTextClearance()
        compose.onNodeWithTag("tagRenameField").performTextInput("broth")
        answer = null
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithTag("tagRenameField").performTextClearance()
        compose.onNodeWithTag("tagRenameField").performTextInput("no good")
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithText("A tag is letters, digits, - and _, with / for levels, and no spaces.").assertIsDisplayed()
        assertEquals(listOf("stew" to true, "broth" to false), asked)
        assertEquals(emptyList<String?>(), done)
    }

    @Test
    fun waitsForUnsentEditsAndOffersToSyncFirst() {
        var unsent by mutableIntStateOf(2)
        var synced = 0
        val asked = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                RenameTagDialog("soup", setOf("soup"), unsent, onRename = { to, _ -> asked += to; null }, onSyncNow = { synced++ }, onDone = {})
            }
        }
        compose.onNodeWithText("Sync first: this phone has 2 edits not sent yet.").assertIsDisplayed()
        compose.onNodeWithTag("tagRenameConfirm").assertDoesNotExist()
        compose.onNodeWithTag("tagRenameSync").performClick()
        assertEquals(1, synced)
        // Once they are sent, the rename can go.
        unsent = 0
        compose.onNodeWithTag("tagRenameSyncFirst").assertDoesNotExist()
        compose.onNodeWithTag("tagRenameField").performTextClearance()
        compose.onNodeWithTag("tagRenameField").performTextInput("stew")
        compose.onNodeWithTag("tagRenameConfirm").performClick()
        assertEquals(listOf("stew"), asked)
    }

    /** Review S4, S5: the route's gate reads the store's unsent edits, and a rename shows at once. */
    @Test
    fun theRouteWaitsForAnyUnsentEditThenRenamesAndShowsItAtOnce() {
        val db = app.penmoss.data.PenmossDatabase.inMemory(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        try {
            val store = app.penmoss.data.NoteStore(db, now = { 5_000 })
            kotlinx.coroutines.runBlocking {
                store.saveChanges(
                    app.penmoss.engine.api.ChangesPage(
                        2,
                        notes = listOf(
                            app.penmoss.engine.api.ChangedNote("a", 1, "Pea soup", "", 1, tags = listOf("soup")),
                            app.penmoss.engine.api.ChangedNote("b", 2, "Shopping", "", 2, tags = emptyList()),
                        ),
                    ),
                )
                // An edit on a note no tag list here names: it may have typed #soup offline.
                store.addPending("b", "EDIT", "e1")
            }
            val renamed = mutableListOf<Triple<String, String, List<String>>>()
            var synced = 0
            var resynced = 0
            val renamer = object : TagRenamer {
                override suspend fun rename(from: String, to: String, noteIds: List<String>): List<String> {
                    renamed += Triple(from, to, noteIds)
                    return noteIds
                }

                override fun syncNow() {
                    synced++
                }

                override fun syncAfterRename() {
                    resynced++
                }
            }
            compose.setContent { PenmossTheme { TagsRoute(store, renamer, onBack = {}, onOpenTag = {}) } }
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("tag-soup").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("tag-soup").performTouchInput { longClick() }
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("tagRenameSyncFirst").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Sync first: this phone has an edit not sent yet.").assertIsDisplayed()
            compose.onNodeWithTag("tagRenameSync").performClick()
            assertEquals(1, synced)
            // Sent: the rename can go.
            kotlinx.coroutines.runBlocking { db.updates().delete(db.updates().updates("b", app.penmoss.data.UpdateEntity.PENDING).map { it.id }) }
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("tagRenameConfirm").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("tagRenameField").performTextClearance()
            compose.onNodeWithTag("tagRenameField").performTextInput("stew")
            compose.onNodeWithTag("tagRenameConfirm").performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("tag-stew").fetchSemanticsNodes().isNotEmpty() }
            assertEquals(listOf(Triple("soup", "stew", listOf("a"))), renamed)
            assertEquals(1, resynced)
            compose.onNodeWithTag("tag-soup").assertDoesNotExist()
            compose.onNodeWithText("Renamed #soup to #stew in 1 note").assertIsDisplayed()
        } finally {
            db.close()
        }
    }

    @Test
    fun homesOverflowOpensTags() {
        var tags = 0
        compose.setContent {
            PenmossTheme {
                app.penmoss.ui.screens.HomeScreen(
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onTags = { tags++ },
                )
            }
        }
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeTags").performClick()
        assertEquals(1, tags)
    }

    @Test
    fun showsAParentsChildrenOnlyUnderItOpen() {
        assertEquals(listOf("area", "soup"), tagRows(tree, emptySet()).map { it.first.tag })
        assertEquals(listOf("area" to 0, "area/cooking" to 1, "area/garden" to 1, "soup" to 0), tagRows(tree, setOf("area")).map { it.first.tag to it.second })
    }
}
