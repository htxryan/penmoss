package app.penmoss

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.metrics.performance.JankStats
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteListRow
import app.penmoss.ui.Items
import app.penmoss.ui.NoteList
import app.penmoss.ui.PenmossTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * T32's "native lists scroll at 60 fps with 5,000 notes", measured on a
 * device (the worker has no emulator): flings through 5,000 notes while
 * JankStats records every frame, then checks that at most 5% of frames
 * missed their deadline. Run on the Pixel with
 * `./gradlew :app:connectedDebugAndroidTest` (docs/android.md).
 */
@RunWith(AndroidJUnit4::class)
class NoteListJankTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun flingsThroughFiveThousandNotesWithoutJank() {
        val rows = (0 until 5_000).map { i ->
            NoteListRow("note-$i", "Note $i", "The first line of note $i, long enough to reach the edge", 1_760_000_000_000L - i * 60_000L, null, "a$i")
        }
        val items = Items.notes(rows, now = System.currentTimeMillis())
        compose.setContent { PenmossTheme { NoteList(items, onOpen = {}) } }
        compose.waitForIdle()

        val frames = Collections.synchronizedList(mutableListOf<Boolean>())
        lateinit var stats: JankStats
        compose.runOnUiThread {
            stats = JankStats.createAndTrack(compose.activity.window) { frame -> frames += frame.isJank }
        }
        repeat(30) {
            compose.onNodeWithTag("noteList").performTouchInput { swipeUp(durationMillis = 120) }
        }
        repeat(10) {
            compose.onNodeWithTag("noteList").performTouchInput { swipeDown(durationMillis = 120) }
        }
        compose.waitForIdle()
        compose.runOnUiThread { stats.isTrackingEnabled = false }

        val janky = frames.count { it }
        assertTrue("only ${frames.size} frames recorded", frames.size > 60)
        assertTrue("$janky of ${frames.size} frames were janky", janky <= frames.size / 20)
    }
}
