package app.penmoss.ui.tags

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.AiNowAnswer
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.notes.TagTree
import app.penmoss.ui.common.PenmossTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Tag descriptions on the phone (A1677, PEN-10 gap 3): the Tags screen shows each tag's
 * description, its long-press menu adds, edits, clears or generates one, and Generate All asks
 * first, saying how many tags go; without an AI provider it points to Settings → AI Descriptions.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TagDescriptionsTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun setUp() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 5_000 })
        runBlocking {
            store.saveChanges(
                ChangesPage(
                    2,
                    notes = listOf(
                        ChangedNote("a", 1, "Beds", "", 1, tags = listOf("garden", "summer")),
                        ChangedNote("b", 2, "Seeds", "", 2, tags = listOf("garden/seeds")),
                    ),
                ),
            )
        }
    }

    @After
    fun tearDown() = db.close()

    /** The engine page, as the route asks it: what was asked, and what it answers. */
    private class FakeDescriber(override var ready: Boolean = true) : TagDescriber {
        val written = mutableListOf<Pair<String, String>>()
        val generated = mutableListOf<String>()
        val all = mutableListOf<Boolean>()
        var answer: (String) -> AiNowAnswer = { tag -> AiNowAnswer(ok = true, text = "Notes about $tag.") }
        var gate: CompletableDeferred<Unit>? = null
        var syncs = 0

        override suspend fun setDescription(tag: String, description: String): String? {
            written += tag to description
            return description.takeIf { it.isNotBlank() }
        }

        override suspend fun generate(tag: String): AiNowAnswer {
            generated += tag
            gate?.await()
            return answer(tag)
        }

        override suspend fun generateAll(replace: Boolean): Int {
            all += replace
            return if (replace) 4 else 3
        }

        override fun synced() {
            syncs++
        }
    }

    private val noRename = object : TagRenamer {
        override suspend fun rename(from: String, to: String, noteIds: List<String>) = noteIds

        override fun syncNow() = Unit

        override fun syncAfterRename() = Unit
    }

    private fun show(describer: FakeDescriber, onSettings: () -> Unit = {}) {
        compose.setContent { PenmossTheme { TagsRoute(store, noRename, onBack = {}, onOpenTag = {}, describer = describer, onOpenAiSettings = onSettings) } }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tag-garden").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun waitFor(tag: String) = compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun descriptions() = runBlocking { store.observeTagDescriptions().first() }

    @Test
    fun showsEachTagsDescriptionFirstLineAndWhileOneIsGenerated() {
        val tree = TagTree.build(listOf(listOf("garden", "summer"), listOf("garden/seeds")))
        compose.setContent {
            PenmossTheme {
                TagsScreen(
                    tree,
                    onBack = {},
                    onOpenTag = {},
                    onMenu = {},
                    descriptions = mapOf("garden" to "Growing food.\nAnd flowers.", "summer" to "  "),
                    generating = setOf("summer"),
                )
            }
        }
        compose.onNodeWithTag("tagDescription-garden", useUnmergedTree = true).assertTextEquals("Growing food. …")
        compose.onNodeWithContentDescription("#garden, 2 notes, Growing food.\nAnd flowers.").assertIsDisplayed()
        // A blank one is no description; one being generated says so.
        compose.onNodeWithTag("tagDescription-summer", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("tagGenerating-summer", useUnmergedTree = true).assertTextEquals("Generating…")
        assertEquals("One line", descriptionLine("One line"))
        assertEquals("First …", descriptionLine("First\nSecond"))
    }

    @Test
    fun theTreeKeepsTheNotebooksDescriptionsForTheScreen() = runBlocking {
        store.saveTree(SyncTree(hash = "h1", tagDescriptions = JsonObject(mapOf("garden" to JsonPrimitive("Growing food."), "x" to JsonPrimitive(" ")))))
        assertEquals(mapOf("garden" to "Growing food."), descriptions())
        // A page older than A1677 sends none: what Room has stands.
        store.saveTree(SyncTree(hash = "h2"))
        assertEquals(mapOf("garden" to "Growing food."), descriptions())
        store.setTagDescriptionLocally("summer", "Hot months.")
        store.setTagDescriptionLocally("garden", null)
        assertEquals(mapOf("summer" to "Hot months."), descriptions())
    }

    @Test
    fun theMenuAddsEditsAndClearsADescriptionWithUndo() {
        val describer = FakeDescriber()
        show(describer)
        compose.onNodeWithTag("tag-garden").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-rename").assertIsDisplayed()
        compose.onNodeWithTag("tagAction-generate").assertTextEquals("Generate AI Description")
        // Nothing to clear yet.
        compose.onNodeWithTag("tagAction-clear").assertDoesNotExist()
        compose.onNodeWithTag("tagAction-describe").assertTextEquals("Add Description…").performClick()
        compose.onNodeWithText("Description of #garden").assertIsDisplayed()
        compose.onNodeWithTag("tagDescriptionSave").assertIsNotEnabled()
        compose.onNodeWithTag("tagDescriptionField").performTextInput("Growing food.")
        compose.onNodeWithTag("tagDescriptionSave").performClick()
        waitFor("tagDescription-garden")
        compose.onNodeWithTag("tagDescription-garden", useUnmergedTree = true).assertTextEquals("Growing food.")
        compose.onNodeWithTag("tagStatus").assertTextEquals("Saved the description of #garden.")
        assertEquals(listOf("garden" to "Growing food."), describer.written)
        assertEquals(1, describer.syncs)

        // Edit: the field starts with what it says.
        compose.onNodeWithTag("tag-garden").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-describe").assertTextEquals("Edit Description…").performClick()
        compose.onNodeWithTag("tagDescriptionField").performTextClearance()
        compose.onNodeWithTag("tagDescriptionField").performTextInput("Vegetables.")
        compose.onNodeWithTag("tagDescriptionSave").performClick()
        compose.waitUntil(5_000) { descriptions()["garden"] == "Vegetables." }

        // Clear, then Undo puts it back.
        compose.onNodeWithTag("tag-garden").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-clear").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tagDescription-garden", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("tagStatus").assertTextEquals("Cleared the description of #garden.")
        assertEquals("garden" to "", describer.written.last())
        compose.onNodeWithTag("tagUndo").performClick()
        waitFor("tagDescription-garden")
        compose.onNodeWithTag("tagDescription-garden", useUnmergedTree = true).assertTextEquals("Vegetables.")
        compose.onNodeWithTag("tagStatus").assertTextEquals("The description of #garden is as it was.")
        assertEquals("garden" to "Vegetables.", describer.written.last())
    }

    @Test
    fun generatesOneTagsDescriptionAndSaysWhenItFails() {
        val describer = FakeDescriber().apply { gate = CompletableDeferred() }
        show(describer)
        compose.onNodeWithTag("tag-summer").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-generate").performClick()
        waitFor("tagGenerating-summer")
        describer.gate!!.complete(Unit)
        waitFor("tagDescription-summer")
        compose.onNodeWithTag("tagDescription-summer", useUnmergedTree = true).assertTextEquals("Notes about summer.")
        compose.onNodeWithTag("tagStatus").assertTextEquals("Wrote a description of #summer.")
        assertEquals(listOf("summer"), describer.generated)
        assertEquals("Notes about summer.", descriptions()["summer"])
        // Undo: it had none, so it has none again.
        compose.onNodeWithTag("tagUndo").performClick()
        compose.waitUntil(5_000) { descriptions()["summer"] == null }

        describer.gate = null
        describer.answer = { AiNowAnswer(ok = false, code = "offline", message = "No connection to Anthropic.") }
        compose.onNodeWithTag("tag-garden").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-generate").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Couldn’t generate a description of #garden: No connection to Anthropic.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tagUndo").assertDoesNotExist()
        compose.onNodeWithTag("tagDescription-garden", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun withoutAProviderPointsToSettings() {
        val describer = FakeDescriber(ready = false)
        var opened = 0
        show(describer) { opened++ }
        compose.onNodeWithTag("tag-garden").performTouchInput { longClick() }
        compose.onNodeWithTag("tagAction-generate").performClick()
        compose.onNodeWithText("Choose an AI Provider").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Choose an AI Provider").assertDoesNotExist()
        compose.onNodeWithTag("tagsGenerateAll").performClick()
        compose.onNodeWithTag("tagsOpenAiSettings").performClick()
        assertEquals(1, opened)
        assertEquals(emptyList<String>(), describer.generated)
        assertEquals(emptyList<Boolean>(), describer.all)
    }

    @Test
    fun generateAllAsksFirstSayingHowManyTagsGo() {
        runBlocking { store.setTagDescriptionLocally("summer", "Hot months.") }
        val describer = FakeDescriber()
        show(describer)
        compose.onNodeWithTag("tagsGenerateAll").assertTextEquals("Generate All…").performClick()
        compose.onNodeWithText("Generate All Tag Descriptions?").assertIsDisplayed()
        // garden and garden/seeds have none; summer has one.
        compose.onNodeWithTag("tagsGenerateCount")
            .assertTextEquals("2 tags have no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.")
        compose.onNodeWithTag("tagsGenerateStart").assertTextEquals("Generate 2 Descriptions")
        compose.onNodeWithTag("tagsGenerateReplace").performClick()
        compose.onNodeWithTag("tagsGenerateStart").assertTextEquals("Generate 3 Descriptions").assertIsEnabled()
        assertEquals(emptyList<Boolean>(), describer.all)
        compose.onNodeWithTag("tagsGenerateStart").performClick()
        compose.waitUntil(5_000) { describer.all.isNotEmpty() }
        assertEquals(listOf(true), describer.all)
        compose.onNodeWithTag("tagStatus").assertTextEquals("Generating descriptions of 4 tags in the background.")
    }

    @Test
    fun saysWhatGenerateAllCovers() {
        val tree = TagTree.build(listOf(listOf("garden", "summer"), listOf("garden/seeds")))
        assertEquals(listOf("garden", "garden/seeds", "summer"), tagsToDescribe(tree, emptyMap(), replace = false))
        assertEquals(listOf("garden/seeds"), tagsToDescribe(tree, mapOf("garden" to "x", "summer" to "y"), replace = false))
        assertEquals(3, tagsToDescribe(tree, mapOf("garden" to "x"), replace = true).size)
        assertEquals("Every tag has a description already.", generateAllWords(0, replace = false))
        assertEquals("1 tag has no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.", generateAllWords(1, replace = false))
    }
}
