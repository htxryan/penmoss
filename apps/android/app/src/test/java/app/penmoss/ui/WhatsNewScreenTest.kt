package app.penmoss.ui

import androidx.compose.ui.test.assertIsDisplayed
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
        compose.setContent { WhatsNewScreen(notesView(file, "0.2.1"), onOpenReleases = {}, onBack = {}) }
        compose.onNodeWithTag("whatsNewCurrent").assertIsDisplayed()
        compose.onNodeWithText("In this version").assertIsDisplayed()
        compose.onNodeWithText("• Release notes in the app.").assertIsDisplayed()
        compose.onNodeWithText("• The keyboard stays down.").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("• Mac only.").fetchSemanticsNodes().size)
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
}
