package app.penmoss.ui

import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.screens.HomeScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Home's notebook heading as the sidebar's notebook bar (T52 items 10, 11): the name with its sync
 * dot, then icon-only Sort, New Folder and Trash; and a dot whose state reads from its shape too.
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
                    recent = emptyList(),
                    folders = listOf(FolderItem("a", "A")),
                    status = "Synced at 3:42 PM",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onNotebookNewNote = { events += "note" },
                    onNewFolder = { events += "folder" },
                    onTrash = { events += "trash" },
                    sortMode = sortMode,
                    onSort = { events += "sort:$it" },
                    defaultNotebook = "Personal",
                )
            }
        }
    }

    private val inBar = hasAnyAncestor(hasTestTag("homeNotebookBar"))

    /** A long press on the heading (T53 item 4): New Note, Sort Order…, New Folder and Trash; the dot stays at its end. */
    @Test
    fun theHeadingsLongPressCarriesNewNoteSortNewFolderAndTrash() {
        val events = mutableListOf<String>()
        home(events)
        // Nothing on the row itself but the name and the dot.
        compose.onNodeWithTag("homeSort").assertDoesNotExist()
        val heading = compose.onNodeWithTag("homeFoldersTitle")
        // The dot at the row's far right, as on the web (A979).
        val row = heading.fetchSemanticsNode().boundsInRoot
        val dot = compose.onNodeWithTag("syncDot", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("dot $dot at the end of $row", row.right - dot.right < row.width / 10)
        heading.performTouchInput { longClick() }
        compose.onNodeWithTag("homeSort").performClick()
        // The order in use is marked in the menu.
        compose.onNodeWithTag("sort-alpha").assertIsSelected()
        compose.onNodeWithTag("sort-manual").assertIsNotSelected()
        compose.onNodeWithTag("sort-modified").performClick()
        heading.performTouchInput { longClick() }
        compose.onNodeWithTag("homeNotebookNewNote").assertTextEquals("New Note in This Notebook").performClick()
        heading.performTouchInput { longClick() }
        compose.onNodeWithTag("homeNotebookNewFolder").performClick()
        heading.performTouchInput { longClick() }
        compose.onNodeWithTag("homeNotebookTrash").performClick()
        assertEquals(listOf("sort:modified", "note", "folder", "trash"), events)
    }

    @Test
    fun theTopBarNoLongerHoldsSort() {
        home(mutableListOf())
        compose.onNode(hasTestTag("homeSort") and hasAnyAncestor(hasTestTag("homeNotebookBar")).not()).assertDoesNotExist()
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

    /**
     * The dot drawn for [state]. All three are drawn side by side once, so no capture waits on a
     * state change to recompose (a stale frame there made CI read the ring of the state before).
     */
    private fun drawn(state: DotState): Pair<Bitmap, Color> {
        if (colours.isEmpty()) {
            compose.setContent {
                PenmossTheme {
                    val scheme = MaterialTheme.colorScheme
                    colours[DotState.SYNCED] = scheme.primary
                    colours[DotState.OFFLINE] = scheme.onSurfaceVariant
                    colours[DotState.STOPPED] = scheme.error
                    Row { drawnStates.forEach { SyncStateDot(SyncDot(it, "words")) } }
                }
            }
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
