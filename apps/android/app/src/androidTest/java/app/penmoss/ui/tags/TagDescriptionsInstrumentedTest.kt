package app.penmoss.ui.tags

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.analytics.OnScreen
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.AiNowAnswer
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.TagsToDescribe
import app.penmoss.engine.notes.TagTree
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.common.SNACKBAR_TAG
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A1677's Android proof (it replaces PEN-68's `TagsUnchangedInstrumentedTest`, whose phone had
 * no descriptions): the Tags screen shows each tag with the first line of its description, a
 * long press opens its sheet (Rename…, Add or Edit Description…, Generate AI Description, Clear
 * Description), and Generate AI Description writes one from a stubbed AI provider, said in the
 * app's snackbar with Undo, which puts back what the tag had. Run with
 * `task proof:android -- app.penmoss.ui.tags.TagDescriptionsInstrumentedTest`.
 *
 * Reads the screen through [OnScreen] (Compose's semantics tree, and the accessibility tree for
 * the sheet's own window), never the Compose test rule.
 */
@RunWith(AndroidJUnit4::class)
class TagDescriptionsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun eachTagShowsItsDescriptionAndALongPressOffersItsActions() {
        val tree = TagTree.build(listOf(listOf("garden", "reading"), listOf("garden/seeds"), listOf("reading")))
        val descriptions = mapOf(
            "garden" to "Raised beds, what grows in them and when.\nAnd the shed.",
            "reading" to "Books to read and notes on those read.",
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        var menu by remember { mutableStateOf<String?>(null) }
                        TagsScreen(tree, onBack = {}, onOpenTag = {}, onMenu = { menu = it }, descriptions = descriptions, onGenerateAll = {})
                        menu?.let { tag ->
                            TagMenuSheet(tag, described = descriptions[tag] != null, onRename = {}, onEditDescription = {}, onGenerate = {}, onClear = {}, onDismiss = { menu = null })
                        }
                    }
                }
            }
            val screen = OnScreen(scenario)
            // Each tag with its count and its description's first line, as the Mac's Tags page.
            screen.text("#garden")
            assertEquals("Raised beds, what grows in them and when. …", screen.tagged("tagDescription-garden").text())
            assertEquals("Books to read and notes on those read.", screen.tagged("tagDescription-reading").text())
            screen.text("Generate All…")
            longPress(screen, "tag-garden")
            // The sheet, in its own window: the tag, then its four actions in the Mac's order.
            screen.dialogText("#garden")
            val actions = listOf("Rename…", "Edit Description…", "Generate AI Description", "Clear Description")
            val tops = actions.map { action ->
                val bounds = android.graphics.Rect()
                screen.dialogText(action).getBoundsInScreen(bounds)
                bounds.top
            }
            assertEquals(tops.sorted(), tops)
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    @Test
    fun generateAiDescriptionWritesOneWithUndoInTheSnackbar() {
        Phone().use { phone ->
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                phone.show(scenario)
                val screen = OnScreen(scenario)
                screen.tagged("tag-garden")
                assertFalse(screen.has("Raised beds and what grows in them."))
                longPress(screen, "tag-garden")
                screen.dialogTap("Generate AI Description")
                // The answer is the tag's description now, and the snackbar offers Undo.
                screen.text("Raised beds and what grows in them.")
                screen.text("Wrote a description of #garden.")
                screen.tagged(SNACKBAR_TAG)
                screen.text("Undo")
                assertEquals(listOf("garden"), phone.describer.generated)
                assertEquals("Raised beds and what grows in them.", phone.descriptions()["garden"])
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }

    @Test
    fun undoPutsBackTheDescriptionTheTagHad() {
        Phone().use { phone ->
            runBlocking { phone.store.setTagDescriptionLocally("garden", "Beds.") }
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                phone.show(scenario)
                val screen = OnScreen(scenario)
                screen.text("Beds.")
                longPress(screen, "tag-garden")
                screen.dialogTap("Generate AI Description")
                screen.text("Raised beds and what grows in them.")
                screen.tap(screen.text("Undo"))
                // What it said before, written back through the engine page, and said so.
                screen.text("The description of #garden is as it was.")
                screen.text("Beds.")
                assertFalse(screen.has("Raised beds and what grows in them."))
                assertEquals("garden" to "Beds.", phone.describer.written.last())
                assertEquals("Beds.", phone.descriptions()["garden"])
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }

    /** Runs [tag]'s long press, as a finger held on it. */
    private fun longPress(screen: OnScreen, tag: String) {
        val node = screen.tagged(tag)
        var ok = false
        instrumentation.runOnMainSync { ok = node.config.getOrNull(SemanticsActions.OnLongClick)?.action?.invoke() == true }
        assertTrue("no long press on [$tag]", ok)
        instrumentation.waitForIdleSync()
    }

    private fun androidx.compose.ui.semantics.SemanticsNode.text(): String =
        config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString("") { it.text }

    /** The engine page as Tags' route asks it, its AI provider stubbed: what was asked, and its answer. */
    private class FakeDescriber : TagDescriber {
        override val ready = true
        val written = mutableListOf<Pair<String, String>>()
        val generated = mutableListOf<String>()

        override suspend fun setDescription(tag: String, description: String): String? {
            written += tag to description
            return description.takeIf { it.isNotBlank() }
        }

        override suspend fun generate(tag: String): AiNowAnswer {
            generated += tag
            return AiNowAnswer(ok = true, text = "Raised beds and what grows in them.")
        }

        override suspend fun toDescribe() = TagsToDescribe(missing = 1, all = 2)

        override suspend fun generateAll(replace: Boolean) = 0

        override fun synced() = Unit
    }

    /** A phone's notes in memory, two tagged, and Tags' route over them. */
    private inner class Phone : AutoCloseable {
        val db = PenmossDatabase.inMemory(instrumentation.targetContext)
        val store = NoteStore(db)
        val describer = FakeDescriber()

        init {
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

        private val noRename = object : TagRenamer {
            override suspend fun rename(from: String, to: String, noteIds: List<String>) = noteIds

            override fun syncNow() = Unit

            override fun syncAfterRename() = Unit
        }

        fun show(scenario: ActivityScenario<ComponentActivity>) = scenario.onActivity { activity ->
            // Undo held open for the spec: a loaded emulator can take longer than its 8 s.
            activity.setContent { PenmossTheme { TagsRoute(store, noRename, onBack = {}, onOpenTag = {}, describer = describer, undoFor = 120_000) } }
        }

        fun descriptions() = runBlocking { store.observeTagDescriptions().first() }

        override fun close() = db.close()
    }
}
