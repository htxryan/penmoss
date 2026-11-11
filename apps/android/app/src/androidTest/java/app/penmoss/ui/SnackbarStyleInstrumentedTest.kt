package app.penmoss.ui

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.proof.ProofShot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

/**
 * PEN-63's Android proof: every snackbar is the web's toast, a square card on the theme's raised
 * surface with its border and text colour, led by its tone's glyph, centred at the bottom and only as wide as its text
 * (up to 380 dp), light and dark, its action in the accent. Run in the factory's proof with
 * `task proof:android -- app.penmoss.ui.SnackbarStyleInstrumentedTest`.
 *
 * Reads the screen through Compose's semantics tree and a screenshot, not the Compose test rule:
 * the rule's Espresso link doesn't start on the API 37 emulator (InputManager.getInstance is gone).
 */
@RunWith(AndroidJUnit4::class)
class SnackbarStyleInstrumentedTest {
    private class Shown(val message: String, val tone: SnackbarTone, val action: String?, val dark: Boolean)

    @Test
    fun aSnackbarIsARaisedCardCentredAtTheBottomLightAndDark() {
        var show by mutableStateOf(Shown("Moved 1 note to “Personal”", SnackbarTone.Done, null, dark = false))
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme(dark = show.dark) {
                        val state = remember { SnackbarHostState() }
                        LaunchedEffect(show) {
                            state.currentSnackbarData?.dismiss()
                            state.say(show.message, show.tone, actionLabel = show.action, duration = SnackbarDuration.Indefinite)
                        }
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                            Text("Penmoss", Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onBackground)
                            // As PenmossRoot places its host: bottom centre, above the navigation bar.
                            SnackbarHost(state, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 72.dp)) {
                                PenmossSnackbar(it)
                            }
                        }
                    }
                }
            }
            check(scenario, dark = false, message = "Moved 1 note to “Personal”", tone = SnackbarTone.Done)
            SystemClock.sleep(2_000)

            // Dark, with Trash's Undo: the dark theme's raised surface, the action in the accent.
            scenario.onActivity { show = Shown("Moved “Garden plan” to Trash", SnackbarTone.Trash, "Undo", dark = true) }
            check(scenario, dark = true, message = "Moved “Garden plan” to Trash", tone = SnackbarTone.Trash, action = "Undo")
            // The proof's screenshot, while the snackbar is on screen (A1255).
            ProofShot.take()
            SystemClock.sleep(2_000)
        }
    }

    private fun check(scenario: ActivityScenario<ComponentActivity>, dark: Boolean, message: String, tone: SnackbarTone, action: String? = null) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var card: Rect? = null
        var texts = emptyList<String>()
        var glyph: Rect? = null
        var root: View? = null
        val deadline = SystemClock.uptimeMillis() + 30_000
        do {
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                root = activity.window.decorView
                val found = snackbarOn(activity.window.decorView)
                card = found?.first
                texts = found?.second.orEmpty()
            }
            if (card != null && message in texts && (action == null || action in texts)) break
            SystemClock.sleep(250)
        } while (SystemClock.uptimeMillis() < deadline)
        // Let it finish fading and scaling in before it is measured.
        SystemClock.sleep(800)
        instrumentation.waitForIdleSync()
        scenario.onActivity { activity ->
            card = snackbarOn(activity.window.decorView)?.first
            glyph = tagged(activity.window.decorView, snackbarGlyphTag(tone))
        }
        val bounds = card ?: error("no snackbar on screen: $texts")
        assertTrue(texts.toString(), message in texts)
        if (action != null) assertTrue(texts.toString(), action in texts)
        // Led by its tone's glyph (the check, or Trash's bin), as the web toast is.
        val lead = glyph ?: error("no ${tone.name} glyph in the snackbar")
        assertTrue("glyph $lead in $bounds", lead.left >= bounds.left && lead.right <= bounds.right && lead.left - bounds.left < 24 * screenDensity(scenario))

        val screen = root!!
        val density = screen.resources.displayMetrics.density
        val width = screen.width.toFloat()
        // Centred, narrower than the screen, no wider than 380 dp.
        assertTrue("centre ${bounds.center.x} on $width", abs(bounds.center.x - width / 2) <= 2f)
        assertTrue("width ${bounds.width} of $width", bounds.width < width - 24 * density)
        assertTrue("width ${bounds.width}", bounds.width <= 380 * density + 1)
        // In the bottom half of the screen.
        assertTrue("top ${bounds.top} of ${screen.height}", bounds.top > screen.height / 2f)

        // Its pixels: the raised surface inside, the border at the edge.
        val theme = penmossColours(emptyMap(), dark)
        val colours = snackbarColours(theme)
        val shot: Bitmap = instrumentation.uiAutomation.takeScreenshot()
        val at = IntArray(2).also { screen.getLocationOnScreen(it) }
        val inside = shot.getPixel((at[0] + bounds.left + 8 * density).toInt(), (at[1] + bounds.center.y).toInt())
        assertClose("surface", colours.container, inside)
        val edge = shot.getPixel((at[0] + bounds.left + density * 0.5f).toInt(), (at[1] + bounds.center.y).toInt())
        assertClose("border", colours.border, edge, tolerance = 24)
        assertEquals(ReadableColours(emptyMap(), dark).raised, colours.container)
    }

    private fun assertClose(what: String, expected: Color, pixel: Int, tolerance: Int = 3) {
        val want = expected.toArgb()
        val channels = listOf(16, 8, 0).map { shift -> abs(((want shr shift) and 0xFF) - ((pixel shr shift) and 0xFF)) }
        assertTrue("$what: #%06x, not #%06x".format(pixel and 0xFFFFFF, want and 0xFFFFFF), channels.all { it <= tolerance })
    }

    private fun screenDensity(scenario: ActivityScenario<ComponentActivity>): Float {
        var density = 1f
        scenario.onActivity { density = it.resources.displayMetrics.density }
        return density
    }

    private fun nodesOn(view: View): List<androidx.compose.ui.semantics.SemanticsNode> {
        val roots = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) roots += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return roots.flatMap { it.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false) }
    }

    /** The bounds in the window of the node tagged [tag], if one is on screen. */
    private fun tagged(view: View, tag: String): Rect? =
        nodesOn(view).firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag }?.boundsInWindow

    /** The snackbar's card in window coordinates, and every text on screen. */
    private fun snackbarOn(view: View): Pair<Rect, List<String>>? {
        val nodes = nodesOn(view)
        val texts = nodes.flatMap { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } }
        val card = nodes.firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == SNACKBAR_TAG } ?: return null
        return card.boundsInWindow to texts
    }
}
