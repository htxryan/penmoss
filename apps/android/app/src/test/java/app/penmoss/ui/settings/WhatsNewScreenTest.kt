package app.penmoss.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.settings.WhatsNewScreen
import app.penmoss.updates.NotesView
import app.penmoss.updates.notesView
import app.penmoss.updates.parseNotes
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Settings → What's New (PEN-109): this version's notes, earlier ones, and no file yet. */
@RunWith(AndroidJUnit4::class)
class WhatsNewScreenTest {
    @get:Rule val compose = createComposeRule()

    private val file = parseNotes(
        """{"schema":1,"releases":[{"version":"0.2.0","tag":"v0.2.0","build":1170,"date":"2026-11-08"},{"version":"0.2.1","tag":"v0.2.1","build":1180,"date":"2026-11-20"}],
        "notes":[{"build":1165,"pr":1,"kind":"new","platform":null,"text":"Quick capture."},
        {"build":1172,"pr":2,"kind":"fixed","platform":"android","text":"The keyboard stays down."},
        {"build":1174,"pr":3,"kind":"fixed","platform":"mac","text":"Mac only."},
        {"build":1176,"pr":4,"kind":"new","platform":null,"text":"Release notes in the app."}]}""",
    )

    @Test
    fun showsThisVersionAndEarlierOnesGroupedByKind() {
        compose.setContent { WhatsNewScreen(notesView(file, "0.2.1"), onOpenReleases = {}, onBack = {}, version = "0.2.1") }
        // The version card first (PEN-146): the version once, and no update controls.
        compose.onNodeWithTag("whatsNewVersion").assertIsDisplayed()
        compose.onNodeWithText("Penmoss 0.2.1").assertIsDisplayed()
        compose.onNodeWithText(VERSION_UPDATES).assertIsDisplayed()
        compose.onNodeWithTag("whatsNewCurrent").assertIsDisplayed()
        compose.onNodeWithText("In This Version").assertIsDisplayed()
        // Under the large top app bar (A1560) the list may start below the screen's fold.
        compose.onNodeWithText("• Release notes in the app.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("• The keyboard stays down.").performScrollTo().assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("• Mac only.").fetchSemanticsNodes().size)
        // Earlier Versions open from their button.
        compose.onNodeWithTag("whatsNewEarlier").assertDoesNotExist()
        compose.onNodeWithTag("whatsNewEarlierToggle").performScrollTo().performClick()
        compose.onNodeWithTag("whatsNewEarlier").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("• Quick capture.").performScrollTo().assertIsDisplayed()
        assertEquals(3, compose.onAllNodesWithTag("whatsNewNote").fetchSemanticsNodes().size)
    }

    @Test
    fun withoutAFileItLinksToGitHub() {
        var opened = 0
        compose.setContent { WhatsNewScreen(NotesView.None, onOpenReleases = { opened++ }, onBack = {}) }
        compose.onNodeWithTag("whatsNewMissing").assertIsDisplayed()
        compose.onNodeWithTag("whatsNewReleases").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun aNewerFileLinksToGitHubToo() {
        compose.setContent { WhatsNewScreen(NotesView.Newer, onOpenReleases = {}, onBack = {}) }
        compose.onNodeWithText("This version of Penmoss can’t read the newest release notes. They’re on GitHub.").assertIsDisplayed()
    }

    @Test
    fun openSourceNoticesInTheVersionCardShowsTheNoticesAndDoneClosesThem() {
        compose.setContent { WhatsNewScreen(notesView(file, "0.2.1"), onOpenReleases = {}, onBack = {}, version = "0.2.1") }
        compose.onNodeWithTag("noticesDialog").assertDoesNotExist()
        compose.onNodeWithTag("openSourceNotices").assertIsDisplayed().assertTextEquals("Open Source Notices").performClick()
        compose.onNodeWithTag("noticesDialog").assertIsDisplayed()
        // The web's file itself: Lucide's licence and the Characters' notice.
        val text = compose.onNodeWithTag("noticesText").fetchSemanticsNode()
            .config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("")
        assertEquals(app.penmoss.engine.settings.Notices.text, text)
        org.junit.Assert.assertTrue(text.contains("ISC License"))
        org.junit.Assert.assertTrue(text.contains("UNICODE LICENSE V3"))
        compose.onNodeWithTag("noticesDone").performClick()
        compose.onNodeWithTag("noticesDialog").assertDoesNotExist()
    }
}
