package app.penmoss.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.sync.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** The note's sync icon, its explanation and its pictures notice (T40 P2b), kept from StatusScreensTest at T59. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NoteSyncTest {
    @get:Rule
    val compose = createComposeRule()

    private val events = mutableListOf<String>()

    @Test
    fun theSyncIconSaysItsStateAndExplainsIt() {
        compose.setContent { PenmossTheme { NoteSyncIcon(NoteSync(NoteSyncState.WAITING), onClick = { events += "tap" }) } }
        compose.onNodeWithContentDescription("Sync: Waiting to upload").performClick()
        assertEquals(listOf("tap"), events)
    }

    /** Review of #93, S2: failed pictures say so in the icon and the explanation, which retries. */
    @Test
    fun failedPicturesShowInTheIconAndTheExplanationRetries() {
        val sync = NoteSync(NoteSyncState.PICTURES_FAILED, picturesFailed = 2)
        compose.setContent {
            PenmossTheme {
                NoteSyncIcon(sync, onClick = {})
                NoteSyncExplanation(sync, onSyncStorage = { events += "open" }, onRetryPictures = { events += "retry" }, onDismiss = { events += "close" })
            }
        }
        compose.onNodeWithContentDescription("Sync: 2 pictures failed").assertExists()
        compose.onNodeWithText("2 pictures could not be uploaded", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("retryNotePictures").performClick()
        assertEquals(listOf("close", "retry"), events)
    }

    /** Review of #93, S4: the note's snackbar when one more of its pictures fails, with Retry. */
    @Test
    fun aPictureThatFailsInTheNoteIsSaidWithRetry() {
        var failed by mutableStateOf<Int?>(null)
        val host = SnackbarHostState()
        compose.setContent {
            PenmossTheme {
                Box {
                    PicturesFailedNotice(failed, host, onRetry = { events += "retry" })
                    SnackbarHost(host)
                }
            }
        }
        val text = "A picture in this note could not be uploaded, so other devices show it as missing."
        // Opened with one already failed: said by the icon, not again here.
        failed = 1
        compose.waitForIdle()
        compose.onNodeWithText(text).assertDoesNotExist()
        failed = 2
        compose.waitForIdle()
        compose.onNodeWithText(text).assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick()
        compose.waitForIdle()
        assertEquals(listOf("retry"), events)
        // Fewer (a retry) says nothing.
        failed = 0
        compose.waitForIdle()
        compose.onNodeWithText(text).assertDoesNotExist()
    }

    @Test
    fun theSyncExplanationOpensSyncAndStorage() {
        compose.setContent {
            PenmossTheme { NoteSyncExplanation(NoteSync(NoteSyncState.OFFLINE), onSyncStorage = { events += "open" }, onRetryPictures = {}, onDismiss = { events += "close" }) }
        }
        compose.onNodeWithText("Offline").assertIsDisplayed()
        compose.onNodeWithTag("openSyncStorage").performClick()
        assertEquals(listOf("close", "open"), events)
    }

    @Test
    fun theNotesSyncState() {
        val offline = SyncStatus.Offline(1, serverError = false)
        val failing = SyncStatus.Offline(1, serverError = true)
        fun state(status: SyncStatus, unsent: Int = 0, waiting: Int = 0, failed: Int = 0) = noteSyncState(status, unsent, waiting, failed).state
        assertEquals(NoteSyncState.SYNCED, state(SyncStatus.Synced(1)))
        assertEquals(NoteSyncState.SYNCED, state(SyncStatus.Syncing))
        assertEquals(NoteSyncState.SYNCING, state(SyncStatus.Syncing, unsent = 2))
        assertEquals(NoteSyncState.WAITING, state(SyncStatus.Synced(1), waiting = 1))
        assertEquals(NoteSyncState.OFFLINE, state(offline))
        assertEquals(NoteSyncState.OFFLINE, state(offline, unsent = 3))
        assertEquals(NoteSyncState.FAILING, state(failing, unsent = 3))
        assertEquals(NoteSyncState.SYNCED, state(failing))
        // Review of #93, S2: a picture failed for good is never "Synced", nor hidden by a pass.
        assertEquals(NoteSyncState.PICTURES_FAILED, state(SyncStatus.Synced(1), failed = 1))
        assertEquals(NoteSyncState.PICTURES_FAILED, state(SyncStatus.Syncing, unsent = 1, failed = 2))
        assertEquals(NoteSyncState.PICTURES_FAILED, state(SyncStatus.Synced(1), waiting = 1, failed = 1))
        assertEquals(NoteSyncState.OFFLINE, state(offline, failed = 1))
        val one = noteSyncState(SyncStatus.Synced(1), 0, 0, 1)
        assertEquals("1 picture failed", one.label)
        assertTrue(one.explanation.startsWith("1 picture could not be uploaded, so other devices show it as missing."))
        assertEquals("2 pictures failed", noteSyncState(SyncStatus.Synced(1), 0, 0, 2).label)
        assertEquals("Waiting to upload", noteSyncState(SyncStatus.Synced(1), 1, 0).label)
    }
}
