package app.penmoss.ui

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.proof.ProofShot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-69's Android proof: Copy Agent Reference copies one short line, the git notebook's local
 * MCP server and read_note with the note's short id (the notebook's 4 characters, then the last 8
 * of the note's id), built from what the phone holds, as the web and the Mac copy it. The test
 * puts it on the clipboard and shows it with the snackbar Copy Agent Reference says. Run in the
 * factory's proof with `task proof:android -- app.penmoss.ui.AgentReferenceInstrumentedTest`.
 *
 * Reads the screen through Compose's semantics tree, not the Compose test rule: the rule's
 * Espresso link doesn't start on the API 37 emulator (InputManager.getInstance is gone).
 */
@RunWith(AndroidJUnit4::class)
class AgentReferenceInstrumentedTest {
    private val notebook = "01JQ7M1WQ3R4ZK3V8N2C5D6E7F"
    private val id = "01M6VAE8YFZ99TCZV2SXF7SQ9W"

    @Test
    fun copyAgentReferenceIsOneShortLineWithTheShortId() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val db = PenmossDatabase.inMemory(context)
        val reference = try {
            runBlocking {
                db.notes().insert(NoteEntity(id, title = "Penmoss Roadmap (LATEST)"))
                agentReferenceOf(NoteStore(db), id, "Personal", notebook)
            }
        } finally {
            db.close()
        }!!
        val expected = "Reference note via Penmoss MCP (penmoss mcp --notebook \"Personal\") tool read_note {\"id\":\"ETD7-SXF7SQ9W\"}"
        assertEquals(expected, reference)
        assertFalse(reference.contains(id))

        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var said = ""
            scenario.onActivity { activity -> said = AgentReference.copy(activity, reference) }
            assertEquals(AgentReference.COPIED, said)
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme(dark = false) {
                        val state = remember { SnackbarHostState() }
                        LaunchedEffect(Unit) { state.say(said, SnackbarTone.Done, duration = SnackbarDuration.Indefinite) }
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                            Column(Modifier.statusBarsPadding().padding(24.dp)) {
                                Text("Penmoss Roadmap (LATEST)", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
                                Text("Copied for an agent:", Modifier.padding(top = 16.dp), color = MaterialTheme.colorScheme.onBackground)
                                Text(reference, Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.onBackground)
                            }
                            SnackbarHost(state, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 72.dp)) {
                                PenmossSnackbar(it)
                            }
                        }
                    }
                }
            }
            val texts = waitFor(scenario) { reference in it && AgentReference.COPIED in it }
            assertTrue(texts.toString(), reference in texts)
            assertTrue(texts.toString(), AgentReference.COPIED in texts)
            SystemClock.sleep(2_000)
            // The proof's screenshot, while the reference and the snackbar are on screen (A1255).
            ProofShot.take()
            assertTrue(reference.endsWith("{\"id\":\"ETD7-SXF7SQ9W\"}"))
        }
    }

    /** Every text on screen, once [done] holds of them (or after 30 s). */
    private fun waitFor(scenario: ActivityScenario<ComponentActivity>, done: (List<String>) -> Boolean): List<String> {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var texts = emptyList<String>()
        val deadline = SystemClock.uptimeMillis() + 30_000
        do {
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity -> texts = textsOn(activity.window.decorView) }
            if (done(texts)) break
            SystemClock.sleep(250)
        } while (SystemClock.uptimeMillis() < deadline)
        return texts
    }

    private fun textsOn(view: View): List<String> {
        val roots = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) roots += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return roots
            .flatMap { it.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false) }
            .flatMap { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } }
    }
}
