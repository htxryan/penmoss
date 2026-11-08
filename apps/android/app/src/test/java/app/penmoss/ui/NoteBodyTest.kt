package app.penmoss.ui

import android.view.View
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.EditorUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The note screen's slot keeps its one editor page through a note that couldn't be fetched (T39 review). */
@RunWith(AndroidJUnit4::class)
class NoteBodyTest {
    @get:Rule
    val compose = createComposeRule()

    private val missing = EditorUiState(EditorUiState.Phase.UNAVAILABLE, message = "This note isn't on the phone yet.", canRetry = true)

    @Test
    fun tryAgainOpensTheNoteOnTheSamePageAndBuildsNoOther() {
        var state by mutableStateOf(EditorUiState())
        var alive by mutableStateOf(true)
        val built = mutableListOf<View>()
        var retried = 0
        compose.setContent {
            PenmossTheme {
                NoteBody(state, editorAlive = alive, onRetry = { retried++ }) { visible ->
                    AndroidView(
                        factory = { context -> View(context).also { built += it } },
                        update = { it.visibility = if (visible) View.VISIBLE else View.INVISIBLE },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
        compose.waitForIdle()
        assertEquals(1, built.size)
        val page = built.single()
        assertEquals(View.VISIBLE, page.visibility)

        // The fetch failed: the message and Try again cover the page, which stays, hidden.
        state = missing
        compose.onNodeWithText("Try Again").performClick()
        assertEquals(1, retried)
        assertEquals(View.INVISIBLE, page.visibility)
        assertSame(page, built.single())

        // Trying again, then open: still that one page, shown again.
        state = EditorUiState(EditorUiState.Phase.LOADING)
        compose.waitForIdle()
        compose.onNodeWithText("Try Again").assertDoesNotExist()
        assertEquals(View.VISIBLE, page.visibility)
        state = EditorUiState(EditorUiState.Phase.READY, title = "Note")
        compose.waitForIdle()
        assertSame(page, built.single())
        assertEquals(View.VISIBLE, page.visibility)

        // A note deleted for good says so over the page; a renderer gone takes the page away.
        state = EditorUiState(EditorUiState.Phase.GONE, message = "This note was deleted for good.")
        compose.onNodeWithText("This note was deleted for good.").assertExists()
        compose.onNodeWithText("Try Again").assertDoesNotExist()
        alive = false
        compose.waitForIdle()
        assertEquals(1, built.size)
        assertFalse(page.isAttachedToWindow)
    }

    /** Never two editor WebViews (A418): a note opened while the theme preview is alive waits for it. */
    @Test
    fun theNotesPageWaitsWhileTheThemePreviewIsAliveAndStaysOnceMade() {
        var preview by mutableStateOf(true)
        val built = mutableListOf<View>()
        compose.setContent {
            PenmossTheme {
                NoteBody(EditorUiState(EditorUiState.Phase.LOADING), editorAlive = true, onRetry = {}, previewOpen = preview) {
                    AndroidView(factory = { context -> View(context).also { built += it } }, modifier = Modifier.fillMaxSize())
                }
            }
        }
        compose.onNodeWithTag("noteWaiting").assertExists()
        assertEquals(0, built.size)
        // The preview goes: the note's page is made.
        preview = false
        compose.waitForIdle()
        assertEquals(1, built.size)
        compose.onNodeWithTag("noteWaiting").assertDoesNotExist()
        // Once made it stays, whatever happens elsewhere.
        preview = true
        compose.waitForIdle()
        assertEquals(1, built.size)
        assertTrue(built.single().isAttachedToWindow)
    }
}
