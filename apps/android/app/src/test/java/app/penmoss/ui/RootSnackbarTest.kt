package app.penmoss.ui

import android.content.ClipboardManager
import android.content.Context
import android.os.Looper
import androidx.navigation.NavHostController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.DeviceGraph
import app.penmoss.NotebookGraph
import app.penmoss.TestGraphs
import app.penmoss.capture.Captures
import app.penmoss.data.NoteEntity
import app.penmoss.data.PenmossDatabase
import app.penmoss.security.SecretBox
import app.penmoss.stopMainScope
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.NoteSelection
import app.penmoss.ui.common.Picked
import app.penmoss.ui.common.PenmossSnackbarVisuals
import app.penmoss.ui.common.Said
import app.penmoss.ui.common.SnackbarTone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowToast

/**
 * What the root's actions say goes on the snackbar over every screen, never a Toast (A1535): the
 * folder actions, a note's and several notes' moves, the top level's sort and a capture copied.
 * Each says a short sentence with its tone, and replaces the one showing.
 */
@RunWith(AndroidJUnit4::class)
class RootSnackbarTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var graph: NotebookGraph
    private lateinit var root: RootUi
    private val screens = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Before
    fun open() {
        val box = object : SecretBox {
            override fun seal(plain: ByteArray) = plain

            override fun open(sealed: ByteArray) = sealed
        }
        graph = TestGraphs.notebook(context, DeviceGraph(context, database = PenmossDatabase.inMemory(context), box = box))
        root = RootUi(graph, NavHostController(context), context, NoteSelection(), window = null, screenScope = screens)
    }

    @After
    fun close() {
        root.snackbar.currentSnackbarData?.dismiss()
        screens.cancel()
        // The app's work has ended before the database closes, never against a closed pool (A610, A690).
        stopMainScope(graph.scope)
        graph.database.close()
        graph.device.database.close()
    }

    /** The snackbar showing once the action's write is done: its words and its tone. */
    private fun shown(): Said? {
        val until = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < until) {
            shadowOf(Looper.getMainLooper()).idle()
            val visuals = root.snackbar.currentSnackbarData?.visuals as? PenmossSnackbarVisuals
            if (visuals != null) return Said(visuals.message, visuals.tone)
            Thread.sleep(10)
        }
        return null
    }

    /** Runs [action] as a tap does, and waits for what it says. */
    private fun says(action: () -> Unit): Said? {
        root.snackbar.currentSnackbarData?.dismiss()
        shadowOf(Looper.getMainLooper()).idle()
        action()
        return shown()
    }

    private fun folderNamed(name: String): String = runBlocking { graph.store.observeFolders().first().single { it.name == name }.id }

    @Test
    fun theFolderActionsSayWhatTheyDidOnTheSnackbar() {
        assertEquals(Said("Made the folder “Garden”.", SnackbarTone.Done), says { root.createFolder("Garden", null) })
        val garden = folderNamed("Garden")
        assertEquals(Said("Renamed to “Kitchen”.", SnackbarTone.Done), says { root.renameFolder(garden, "Kitchen") })
        assertEquals(Said("Already in Top level.", SnackbarTone.Info), says { root.moveFolder(garden, null) })
        assertEquals(Said("Sorted A–Z.", SnackbarTone.Done), says { root.sortFolder(null, "alpha") })
        assertEquals(Said("Sorted by last modified.", SnackbarTone.Done), says { root.sortFolder(garden, "modified") })
        assertEquals(
            Said("Moved “Kitchen” to Trash. Its notes moved up.", SnackbarTone.Trash),
            says { root.deleteFolder(FolderItem(garden, "Kitchen")) },
        )
        // A folder gone meanwhile is said as an error.
        assertEquals(Said("That folder isn't on this phone any more.", SnackbarTone.Error), says { root.renameFolder("gone", "Shed") })
        assertEquals(null, ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun aNotesMoveAndSeveralNotesMovesSayWhereTheyWent() {
        runBlocking {
            graph.database.notes().insert(NoteEntity("n1", title = "Soup"))
            graph.database.notes().insert(NoteEntity("n2", title = "Tea"))
        }
        says { root.createFolder("Garden", null) }
        val garden = folderNamed("Garden")
        assertEquals(
            Said("Moved 2 notes to Garden.", SnackbarTone.Done),
            says { root.moveNotes(listOf(Picked("n1", "Soup"), Picked("n2", "Tea")), garden) },
        )
        assertEquals(Said("Moved to Top level.", SnackbarTone.Done), says { root.moveNote("n1", null) })
        assertEquals(Said("Already in Top level.", SnackbarTone.Info), says { root.moveNote("n1", null) })
        assertEquals(null, ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun aRefusedCaptureCopiedSaysSoAndIsOnTheClipboard() {
        val refused = Captures.Refused("c1", "eggs, milk", "too large", 0, "daily", missingPictures = false)
        assertEquals(Said("Copied the capture.", SnackbarTone.Done), says { root.copyCaptures(listOf(refused)) })
        assertEquals("eggs, milk", context.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text)
        assertEquals(Said("Copied 2 captures.", SnackbarTone.Done), says { root.copyCaptures(listOf(refused, refused.copy(id = "c2"))) })
        assertEquals(null, ShadowToast.getTextOfLatestToast())
    }
}
