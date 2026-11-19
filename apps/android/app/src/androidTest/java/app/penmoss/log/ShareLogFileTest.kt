package app.penmoss.log

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.ScreenTree
import app.penmoss.feedback.ErrorScrub
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Settings → Privacy → Share Log File (PEN-137, AC49): the share sheet's chooser, titled "Share
 * Log File", wraps ACTION_SEND of plain text whose stream is a content URI of the app's own
 * `.logs` authority, readable once (FLAG_GRANT_READ_URI_PERMISSION). What it hands over is the log
 * scrubbed twice: a canary token and a note title never reach it. The log itself, in
 * `filesDir/logs/`, has no URI at all. The chooser is caught by an ActivityMonitor, so nothing
 * opens over the app. Run with `task proof:android -- app.penmoss.log.ShareLogFileTest`.
 */
@RunWith(AndroidJUnit4::class)
class ShareLogFileTest {
    @Test
    fun shareLogFileHandsTheScrubbedCopyToTheShareSheet() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        PenmossLog.install(context)
        PenmossLog.known(ErrorScrub.Known(login = "lemurcanary"))
        PenmossLog.warn("ShareLogFileTest", "push as lemurcanary with ghp_CANARY000000000000000000000000000000 failed")
        PenmossLog.info("ShareLogFileTest", "opened Zebracanary Title Q7")
        PenmossLog.drain()

        // The chooser is caught as it starts, and answered in its place: nothing opens over the app.
        val started = java.util.concurrent.LinkedBlockingQueue<Intent>()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_CHOOSER) return null
                started += intent
                return Instrumentation.ActivityResult(Activity.RESULT_OK, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent {
                        PenmossTheme {
                            PrivacyScreen(
                                PrivacyUi(sharing = false, install = "5c0e8f6a12b4c6d8e0f2a4b6c8d07a96"),
                                PrivacyActions(
                                    onShareLog = {
                                        activity.lifecycleScope.launch {
                                            LogShare.share(activity, ErrorScrub.Known(login = "lemurcanary", names = listOf("Zebracanary Title Q7")))
                                        }
                                    },
                                ),
                            )
                        }
                    }
                }
                // The Logs row's button, on screen.
                val deadline = SystemClock.uptimeMillis() + 30_000
                var clicked = false
                do {
                    instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        val button = clickableWithText(activity.window.decorView, "Share Log File")
                        if (button != null) {
                            // Scrolled into view, so the proof shows the Logs row.
                            scrollIntoView(activity.window.decorView, button)
                            button.config[SemanticsActions.OnClick].action?.invoke()
                            clicked = true
                        }
                    }
                    if (clicked) break
                    SystemClock.sleep(250)
                } while (SystemClock.uptimeMillis() < deadline)
                assertTrue("no Share Log File button on screen", clicked)

                val chooser = started.poll(15, java.util.concurrent.TimeUnit.SECONDS) ?: run { fail("no chooser started"); return }
                assertEquals(Intent.ACTION_CHOOSER, chooser.action)
                assertEquals("Share Log File", chooser.getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString())
                @Suppress("DEPRECATION")
                val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                assertNotNull(send)
                assertEquals(Intent.ACTION_SEND, send!!.action)
                assertEquals("text/plain", send.type)
                assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
                @Suppress("DEPRECATION")
                val uri = send.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
                assertEquals("content", uri.scheme)
                assertEquals("${context.packageName}.logs", uri.authority)

                // What it hands over: scrubbed twice, the canaries gone.
                val text = context.contentResolver.openInputStream(uri)!!.use { it.readBytes().decodeToString() }
                assertTrue(text, text.contains("push as ‹login› with ‹token› failed"))
                assertTrue(text, text.contains("opened ‹name›"))
                for (canary in listOf("ghp_CANARY", "lemurcanary", "Zebracanary")) assertFalse(canary, text.contains(canary, ignoreCase = true))

                // The log itself has no URI: the provider shares cacheDir/share/ only.
                val kept = File(File(context.filesDir, "logs"), PenmossLogFiles.CURRENT)
                assertTrue(kept.isFile)
                val refused = runCatching { FileProvider.getUriForFile(context, "${context.packageName}.logs", kept) }.exceptionOrNull()
                assertTrue("filesDir/logs/ has a URI", refused is IllegalArgumentException)

                // Held before the shot, the Privacy page and its Logs row on screen (A1255, A1279).
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    companion object {
        /** The clickable node holding [text] (the button, not its label). */
        fun clickableWithText(view: android.view.View, text: String): androidx.compose.ui.semantics.SemanticsNode? {
            val label = ScreenTree.nodes(view).firstOrNull { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text == text } }
            var node = label
            while (node != null && node.config.getOrNull(SemanticsActions.OnClick) == null) node = node.parent
            return node
        }

        /** Scrolls the page so [node] sits a little below the top of the window. */
        fun scrollIntoView(view: android.view.View, node: androidx.compose.ui.semantics.SemanticsNode) {
            var parent = node.parent
            while (parent != null && parent.config.getOrNull(SemanticsActions.ScrollBy) == null) parent = parent.parent
            val scroller = parent ?: return
            val by = node.boundsInWindow.top - scroller.boundsInWindow.top - scroller.boundsInWindow.height / 3
            if (by > 0) scroller.config[SemanticsActions.ScrollBy].action?.invoke(0f, by)
        }
    }
}
