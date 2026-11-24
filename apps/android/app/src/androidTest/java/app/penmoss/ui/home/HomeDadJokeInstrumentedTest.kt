package app.penmoss.ui.home

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.OnScreen
import app.penmoss.analytics.texts
import app.penmoss.engine.settings.DadJokes
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.DAD_JOKES_HELP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A1676's Android proof: with Settings → Appearance → Dad Jokes on, a dad joke from core's one
 * list heads Home's notes list, a heading under the bar, which keeps the notebook's name; and
 * the switch's help says where the phone shows it. Run with
 * `task proof:android -- app.penmoss.ui.home.HomeDadJokeInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class HomeDadJokeInstrumentedTest {
    @Test
    fun aDadJokeHeadsHomesNotesList() {
        val joke = DadJokes.ALL.first()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        HomeScreen(HomeUi(folders = listOf(FolderItem("a", "Garden Plans"), FolderItem("b", "Reading")), notebook = "Garden", joke = joke), HomeActions())
                    }
                }
            }
            val screen = OnScreen(scenario)
            val heading = screen.tagged("homeJoke")
            assertEquals(listOf(joke), heading.texts())
            assertNotNull("the joke is a heading", heading.config.getOrNull(SemanticsProperties.Heading))
            // Under the bar, which keeps the notebook's name, and above the folders.
            val title = screen.tagged("homeTitle")
            assertEquals(listOf("Garden"), title.texts())
            assertTrue(title.boundsInWindow.bottom <= heading.boundsInWindow.top)
            assertTrue(heading.boundsInWindow.bottom <= screen.text("Garden Plans").boundsInWindow.top)
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    @Test
    fun theSwitchSaysWhereThePhoneShowsTheJoke() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        AppearanceScreen("system", systemDark = false, themes = emptyList(), chosen = "penmoss", enabled = true, onMode = {}, onTheme = {}, onBack = {}, dadJokes = true)
                    }
                }
            }
            val screen = OnScreen(scenario)
            screen.reveal(screen.tagged("dadJokes"), margin = 400f)
            screen.text("Dad Jokes")
            screen.text("A joke at the top of Home’s notes list.")
            assertEquals("A joke at the top of Home’s notes list.", DAD_JOKES_HELP)
            assertEquals(false, screen.has("A joke in place of the heading when no note is open."))
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }
}
