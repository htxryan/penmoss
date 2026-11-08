package app.penmoss.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollToIndex
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteListRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.time.ZoneOffset

/**
 * The structural half of "native lists scroll at 60 fps with 5,000 notes"
 * (T32, A285): with 5,000 notes the list composes only the rows on screen and
 * reuses them while scrolling, and rows get pre-formatted strings, so a frame's
 * work does not grow with the list. The frame-time half runs on the Pixel
 * (androidTest NoteListJankTest); Robolectric does not render real frames.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NoteListScrollTest {
    @get:Rule
    val compose = createComposeRule()

    private val rows = (0 until 5_000).map { i ->
        NoteListRow(
            id = "note-$i",
            title = "Note $i",
            excerpt = "The first line of note $i, long enough to be cut at the edge of the screen like a real one",
            updatedAt = 1_760_000_000_000L - i * 60_000L,
            folderId = null,
            position = "a$i",
        )
    }

    @Test
    fun formatsFiveThousandRowsBeforeTheyReachCompose() {
        val started = System.nanoTime()
        val items = Items.notes(rows, now = 1_760_000_000_000L, zone = ZoneOffset.UTC)
        val ms = (System.nanoTime() - started) / 1_000_000
        assertEquals(5_000, items.size)
        assertEquals("Note 4999", items.last().title)
        // Off the main thread in the app (flowOn(Default)); here only a sanity bound.
        assertTrue("formatting 5,000 rows took $ms ms", ms < 2_000)
    }

    @Test
    fun composesOnlyTheVisibleRowsOfFiveThousand() {
        val items = Items.notes(rows, now = 1_760_000_000_000L, zone = ZoneOffset.UTC)
        lateinit var state: LazyListState
        compose.setContent {
            state = rememberLazyListState()
            PenmossTheme { NoteList(items, onOpen = {}, state = state) }
        }
        val composedAtTop = compose.onAllNodes(hasClickAction()).fetchSemanticsNodes().size
        assertTrue("composed $composedAtTop rows at the top", composedAtTop in 1..40)

        for (index in listOf(1_000, 2_500, 4_999)) {
            compose.onNodeWithTag("noteList").performScrollToIndex(index)
            val composed = compose.onAllNodes(hasClickAction()).fetchSemanticsNodes().size
            assertTrue("composed $composed rows at $index", composed in 1..40)
        }
        compose.onNodeWithText("Note 4999").assertIsDisplayed()
        assertEquals(4_999, state.layoutInfo.visibleItemsInfo.last().index)
    }
}
