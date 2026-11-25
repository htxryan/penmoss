package app.penmoss.ui.home

import android.graphics.Bitmap
import android.view.View
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertTextEquals
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import app.penmoss.ui.common.DotMark
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.common.SyncDot
import app.penmoss.ui.common.SyncStateDot
import app.penmoss.ui.common.mark

/**
 * The notebook as the notes list's title, with its sync dot (A1613), its Sort Order and New Folder
 * in the ⋮ menu; and a dot whose state reads from its shape too.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotebookHeadingTest {
    @get:Rule
    val compose = createComposeRule()

    private fun home(events: MutableList<String>, sortMode: String = "alpha") {
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = listOf(FolderItem("a", "A")),
                        status = "Synced at 3:42 PM",
                        syncing = false,
                        sortMode = sortMode,
                        notebook = "Garden",
                    ),
                    HomeActions(
                        onNotebookNewNote = { events += "note" },
                        onNewFolder = { events += "folder" },
                        onTrash = { events += "trash" },
                        onSort = { events += "sort:$it" },
                    ),
                )
            }
        }
    }

    /**
     * The notebook is the bar's title, once (item 16, A1613): its name and its sync dot, with no
     * heading of its own under the bar; the heading's Sort Order and New Folder are in the ⋮ menu
     * (New Note is the button, Trash the drawer's).
     */
    @Test
    fun theTitleIsTheNotebookWithItsDotAndTheMenuCarriesSortAndNewFolder() {
        val events = mutableListOf<String>()
        home(events)
        compose.onNodeWithTag("homeTitle", useUnmergedTree = true).assertTextEquals("Garden")
        compose.onAllNodesWithText("Garden").assertCountEquals(1)
        compose.onNodeWithTag("homeFoldersTitle").assertDoesNotExist()
        // No gear in the bar: Settings is the drawer's (item 17, A1614).
        compose.onNodeWithTag("homeSettings").assertDoesNotExist()
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        // The dot just after the name.
        val title = compose.onNodeWithTag("homeTitle", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val dot = compose.onNodeWithTag("syncDot", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("dot $dot after $title", dot.left >= title.right - 1f && dot.left - title.right < 40f * compose.density.density)
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeSort").assertTextEquals("Sort Order…").performClick()
        // The order in use is marked in the menu.
        compose.onNodeWithTag("sort-alpha").assertIsSelected()
        compose.onNodeWithTag("sort-manual").assertIsNotSelected()
        compose.onNodeWithTag("sort-modified").performClick()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeNewFolder").performClick()
        assertEquals(listOf("sort:modified", "folder"), events)
    }

    @Test
    fun eachStateHasItsOwnMark() {
        assertEquals(DotMark.SOLID, DotState.SYNCED.mark())
        assertEquals(DotMark.SOLID, DotState.SYNCING.mark())
        assertEquals(DotMark.RING, DotState.OFFLINE.mark())
        assertEquals(DotMark.RING, DotState.IDLE.mark())
        assertEquals(DotMark.BULLSEYE, DotState.STOPPED.mark())
    }

    private val drawnStates = listOf(DotState.SYNCED, DotState.OFFLINE, DotState.STOPPED)
    private val colours = mutableMapOf<DotState, Color>()
    private var composeView: View? = null

    /**
     * The dot drawn for [state]. All three are drawn side by side once, so no capture waits on a
     * state change to recompose (a stale frame there made CI read the ring of the state before).
     * The view is then drawn again before the capture: after an editable TagSheet earlier in the
     * same Robolectric sandbox (OrganiseScreensTest), the capture rendered the view's display list
     * from before the dots were composed, the background alone. Two test forks put the classes in
     * that order (A1523).
     */
    private fun drawn(state: DotState): Pair<Bitmap, Color> {
        if (colours.isEmpty()) {
            compose.setContent {
                PenmossTheme {
                    composeView = LocalView.current
                    val scheme = MaterialTheme.colorScheme
                    colours[DotState.SYNCED] = scheme.primary
                    colours[DotState.OFFLINE] = scheme.onSurfaceVariant
                    colours[DotState.STOPPED] = scheme.error
                    Row { drawnStates.forEach { SyncStateDot(SyncDot(it, "words")) } }
                }
            }
            compose.waitForIdle()
            compose.runOnUiThread { composeView!!.invalidate() }
            compose.waitForIdle()
        }
        val node = compose.onAllNodesWithTag("syncDotMark", useUnmergedTree = true)[drawnStates.indexOf(state)]
        return node.captureToImage().asAndroidBitmap() to colours.getValue(state)
    }

    private fun near(pixel: Int, colour: Color): Boolean {
        val c = colour.toArgb()
        fun ch(v: Int, shift: Int) = (v shr shift) and 0xFF
        return listOf(16, 8, 0).all { kotlin.math.abs(ch(pixel, it) - ch(c, it)) < 40 } && ch(pixel, 24) > 200
    }

    @Test
    fun aSyncedDotIsSolidAnOfflineOneARingAndAStoppedOneABullseye() {
        val (solid, accent) = drawn(DotState.SYNCED)
        assertTrue("a synced dot is filled", near(solid.getPixel(solid.width / 2, solid.height / 2), accent))

        val (ring, muted) = drawn(DotState.OFFLINE)
        assertTrue("an offline ring is hollow", !near(ring.getPixel(ring.width / 2, ring.height / 2), muted))
        assertTrue("an offline ring has its edge", near(ring.getPixel(ring.width / 2, 0), muted) || near(ring.getPixel(ring.width / 2, 1), muted))

        val (bullseye, danger) = drawn(DotState.STOPPED)
        val mid = bullseye.width / 2
        assertTrue("a stopped dot has a centre", near(bullseye.getPixel(mid, bullseye.height / 2), danger))
        // Between the ring and the centre, a gap of the background.
        val gap = (bullseye.height * 0.27f).toInt()
        assertTrue("a stopped dot has a gap", !near(bullseye.getPixel(mid, gap), danger))
    }
}
