package app.penmoss.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.DadJokes
import app.penmoss.engine.settings.JokeDeck
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.SETTINGS_INDEX
import app.penmoss.ui.settings.SettingsRoutes
import app.penmoss.ui.settings.searchSettings
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment

/**
 * Dad Jokes on the phone (PEN-10, the Mac's A1576 and A1598): a joke heads Home's notes list while
 * Settings → Appearance → Dad Jokes is on, the default; off, Home is as it was.
 */
@RunWith(AndroidJUnit4::class)
class HomeJokeTest {
    @get:Rule
    val compose = createComposeRule()

    private val heading = SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)

    @Test
    fun aJokeHeadsTheNotesListAndGoesWhenTurnedOffOrOnAnotherPage() {
        var ui by mutableStateOf(HomeUi(folders = listOf(FolderItem("a", "A")), notebook = "Garden", joke = "What do you call a fake noodle? An impasta."))
        compose.setContent { PenmossTheme { HomeScreen(ui, HomeActions()) } }
        compose.onNodeWithTag("homeJoke").assertIsDisplayed().assertTextEquals("What do you call a fake noodle? An impasta.").assert(heading)
        // The bar keeps the notebook's name (A1613).
        compose.onNodeWithTag("homeTitle").assertTextEquals("Garden")
        // Quick Access is its own page: no joke there.
        compose.runOnIdle { ui = ui.copy(page = HomePage.QUICK_ACCESS) }
        compose.onNodeWithTag("homeJoke").assertDoesNotExist()
        // Off: Home as it was.
        compose.runOnIdle { ui = ui.copy(page = HomePage.NOTES, joke = null) }
        compose.onNodeWithTag("homeJoke").assertDoesNotExist()
        compose.onNodeWithTag("homeTitle").assertTextEquals("Garden")
    }

    @Test
    fun theSwitchIsLastInTextWithTheMacsWordsAndChangesTheSetting() {
        var on by mutableStateOf(true)
        val changed = mutableListOf<Boolean>()
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(
                    "system", systemDark = false, themes = emptyList(), chosen = "penmoss", enabled = true, onMode = {}, onTheme = {}, onBack = {},
                    dadJokes = on,
                    onDadJokes = {
                        changed += it
                        on = it
                    },
                )
            }
        }
        compose.onNodeWithText("A joke in place of the heading when no note is open.").performScrollTo()
        compose.onNodeWithTag("dadJokes").performScrollTo().assertIsOn().performClick()
        compose.onNodeWithTag("dadJokes").assertIsOff().performClick()
        assertEquals(listOf(false, true), changed)
    }

    @Test
    fun searchSettingsFindsItOnAppearance() {
        val entry = SETTINGS_INDEX.single { it.id == "dad-jokes" }
        assertEquals("Dad Jokes", entry.label)
        assertEquals(SettingsRoutes.APPEARANCE, entry.route)
        assertEquals("A joke in place of the heading when no note is open", entry.help)
        for (word in listOf("joke", "welcome", "empty window")) assertTrue(word, searchSettings(SETTINGS_INDEX, word).any { it.id == "dad-jokes" })
    }

    @Test
    fun thePhoneKeepsItsOwnDeckAndTheSettingReadsAsCoreReadsIt() {
        JokeDeck.reset()
        val context = RuntimeEnvironment.getApplication()
        val dealt = (1..DadJokes.ALL.size).map { JokeDeck(HomeJokes.store(context)).draw(DadJokes.ALL) }
        // Every joke once before any comes again, across decks made afresh from the stored one.
        assertEquals(DadJokes.ALL.toSet(), dealt.toSet())
        assertTrue(DadJokes.on(Settings()))
        assertTrue(!DadJokes.on(Settings().with(DadJokes.KEY, JsonPrimitive(false))))
    }
}
