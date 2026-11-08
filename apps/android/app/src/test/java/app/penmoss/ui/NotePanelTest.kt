package app.penmoss.ui

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The note panel (T51, A936) over the note's page. */
@RunWith(AndroidJUnit4::class)
class NotePanelTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * The panel covers the whole note, so the page behind it gives up the focus (T52 pass). Before,
     * with the caret in the note, the keyboard stayed up and connected to the hidden page when the
     * panel opened: what was typed in the Comments tab, with no field of the panel chosen, went
     * into the note unseen.
     */
    @Test
    fun thePanelTakesTheFocusFromThePageItCovers() {
        var page: View? = null
        var shown by mutableStateOf(false)
        compose.setContent {
            Box(Modifier.fillMaxSize()) {
                // The note's page, as its WebView is: focusable in touch mode.
                AndroidView(
                    factory = { context -> View(context).apply { isFocusableInTouchMode = true }.also { page = it } },
                    modifier = Modifier.fillMaxSize(),
                )
                if (shown) {
                    NotePanel(PanelTab.COMMENTS, onTab = {}, onClose = { shown = false }) { Text("Comments") }
                }
            }
        }
        compose.runOnIdle { assertEquals(true, page!!.requestFocus()) }
        compose.runOnIdle { assertEquals(true, page!!.hasFocus()) }

        compose.runOnIdle { shown = true }
        compose.onNodeWithTag("notePanel").assertExists()
        compose.runOnIdle { assertEquals(false, page!!.hasFocus()) }
    }
}
