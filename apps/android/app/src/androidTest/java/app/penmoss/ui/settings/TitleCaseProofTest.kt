package app.penmoss.ui.settings

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.OnScreen
import app.penmoss.analytics.texts
import app.penmoss.editor.WebPictureSetting
import app.penmoss.proof.ProofShot
import app.penmoss.ui.TitleCase
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's Settings in Title Case (PEN-137, AC43; A938 as amended): Settings → Storage says
 * Pictures from the Web and Load Pictures from the Web, its title, headings and controls each held
 * to the same rule as the Mac's ([TitleCase], core's `titleCase()`). `SettingsTitleCaseTest` reads
 * every Settings screen on the JVM; this is the proof on the emulator. Run with
 * `task proof:android -- app.penmoss.ui.settings.TitleCaseProofTest`.
 *
 * Reads the screen through Compose's semantics tree ([OnScreen]), not the Compose test rule.
 */
@RunWith(AndroidJUnit4::class)
class TitleCaseProofTest {
    @Test
    fun storageNamesItsSettingsInTitleCase() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        StorageScreen(
                            StorageUse(files = 12L * 1024 * 1024, webPictures = 1536L * 1024, webPictureCount = 3),
                            WebPictureSetting.WIFI_ONLY,
                            onWebPictures = {},
                            onClearWebPictures = {},
                            onBack = {},
                        )
                    }
                }
            }
            val screen = OnScreen(scenario)
            val load = screen.text("Load Pictures from the Web")
            screen.text("Pictures from the Web")
            // The old casing is gone.
            assertTrue(screen.texts().none { it.contains("From the Web") })
            // Every heading and control on the screen is in Title Case.
            val labels = screen.nodes().filter { node ->
                node.config.contains(SemanticsProperties.Heading) || node.config.contains(SemanticsProperties.Role)
            }.flatMap { it.texts().take(1) }
            assertTrue("no labels read", labels.isNotEmpty())
            assertEquals(emptyList<String>(), labels.mapNotNull { TitleCase.problem(it) })
            screen.reveal(load, margin = 300f)
            // Held before the shot (A1279): the proof's video ends 0.5 s after ProofShot.
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }
}
