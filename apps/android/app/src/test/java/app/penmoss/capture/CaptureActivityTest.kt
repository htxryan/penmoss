package app.penmoss.capture

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.penmoss.AppGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.CaptureSetting
import app.penmoss.engine.api.SyncTree
import app.penmoss.stopMainScope
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import androidx.compose.ui.unit.dp
import org.robolectric.shadows.ShadowToast
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The capture sheet as the share sheet, the tile and the widget open it
 * (T34, A339–A341): the intent's content in the sheet, Save storing it on the
 * phone with no network (the API here is unreachable), the destination Settings
 * chose (T51, A947), and with no git notebook to save to (A1040).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CaptureActivityTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    /** The app's graph (its device settings), and the git notebook's the sheet saves to. */
    private lateinit var main: AppGraph
    private lateinit var graph: AppGraph
    private var scenario: ActivityScenario<CaptureActivity>? = null

    /** A phone with one git notebook (or none), offline: everything here works with no network. */
    private fun phone(notebook: Boolean = true) {
        TestGraphs.forgetNotebooks(app)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        main = TestGraphs.app(app)
        app.useGraph(main)
        if (notebook) graph = main.git.graph(TestGraphs.addNotebook(app, main, "Notes"))
    }

    @After
    fun close() {
        scenario?.close()
        // The app’s work has ended before the databases close, never against a closed pool (A610, A690).
        if (::main.isInitialized) stopMainScope(main.scope)
        if (::graph.isInitialized) graph.database.close()
        if (::main.isInitialized) main.database.close()
        TestGraphs.forgetNotebooks(app)
    }

    private fun launch(intent: Intent) {
        scenario?.close()
        scenario = ActivityScenario.launch(intent.setClass(app, CaptureActivity::class.java))
    }

    private fun stored() = runBlocking { graph.database.captures().all() }

    /**
     * Waits while the main looper runs what was posted to it: Robolectric's looper is paused, and
     * the sheet saves on the app's scope (the main thread) and closes with finish().
     */
    private fun await(condition: () -> Boolean) = compose.waitUntil(5_000) {
        shadowOf(Looper.getMainLooper()).idle()
        condition()
    }

    /** The sheet has closed itself: finishing, or already gone. */
    private fun awaitClosed() = await {
        val current = scenario!!
        current.state == Lifecycle.State.DESTROYED ||
            runCatching {
                var finishing = false
                current.onActivity { finishing = it.isFinishing }
                finishing
            }.getOrDefault(false)
    }

    @Test
    fun aWebPageSharedFromChromeIsSavedOfflineWithItsTitleAndAddress() {
        phone()
        launch(
            Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "https://penmoss.app/android")
                .putExtra(Intent.EXTRA_SUBJECT, "Penmoss for Android"),
        )
        compose.onNodeWithTag("captureText").assert(hasText("Penmoss for Android\n<https://penmoss.app/android>"))
        compose.onNodeWithTag("captureDaily").assertIsSelected()
        compose.onNodeWithTag("captureSave").performClick()
        await { stored().isNotEmpty() }
        val capture = stored().single()
        assertEquals("Penmoss for Android\n<https://penmoss.app/android>", capture.text)
        assertEquals(CaptureRequest.DAILY, capture.destination)
        awaitClosed()
        assertEquals("Saved to today’s note.", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun theTextCanBeEditedAndSentToTheInboxForThisCaptureOnly() {
        phone()
        launch(Intent(ShareIntents.ACTION_CAPTURE))
        compose.onNodeWithTag("captureText").performTextReplacement("Call the vet\nabout Saturday")
        compose.onNodeWithTag("captureInbox").performClick()
        compose.onNodeWithTag("captureInbox").assertIsSelected()
        compose.onNodeWithTag("captureSave").performClick()
        await { stored().isNotEmpty() }
        assertEquals(listOf("Call the vet\nabout Saturday" to CaptureRequest.INBOX), stored().map { it.text to it.destination })
        assertFalse(stored().single().remember)
        awaitClosed()
        assertEquals("Saved as a new note in Inbox.", ShadowToast.getTextOfLatestToast())
        // The next capture starts on Settings' choice again, not the last one picked (T51, A947).
        launch(Intent(ShareIntents.ACTION_CAPTURE))
        compose.onNodeWithTag("captureDaily").assertIsSelected()
    }

    /** `penmoss://capture` (T40 P7, PL5, A476), as the Mac's capture window: the sheet, empty. */
    @Test
    fun aCaptureLinkOpensTheSheetEmptyReadingNothingFromTheLink() {
        phone()
        // Neither the link's query nor an extra another app puts on the VIEW is read (review N6).
        launch(
            Intent(Intent.ACTION_VIEW, Uri.parse("penmoss://capture?text=Delete%20everything"))
                .putExtra(Intent.EXTRA_TEXT, "Delete everything"),
        )
        compose.onNodeWithTag("captureText").assertTextEquals("What’s on your mind?", "")
        compose.onNodeWithTag("captureText").performTextReplacement("Call the vet")
        compose.onNodeWithTag("captureSave").performClick()
        await { stored().isNotEmpty() }
        assertEquals(listOf("Call the vet"), stored().map { it.text })
    }

    /** Any other `penmoss://` link that reaches the sheet closes it at once, saving nothing (PL5). */
    @Test
    fun anyOtherLinkClosesTheSheetSavingNothing() {
        phone()
        launch(Intent(Intent.ACTION_VIEW, Uri.parse("penmoss://capture/now?text=x")))
        awaitClosed()
        assertTrue(stored().isEmpty())
    }

    @Test
    fun theSheetStartsOnTheDestinationTheOtherAppsRemember() {
        phone()
        // The device's setting, as the Journal notebook's device map last gave it (A1014).
        runBlocking { main.store.saveTree(SyncTree(hash = "h", capture = CaptureSetting(CaptureRequest.INBOX))) }
        launch(Intent(ShareIntents.ACTION_CAPTURE))
        compose.onNodeWithTag("captureInbox").assertIsSelected()
    }

    @Test
    fun aPhotoSharedFromPhotosIsStoredAndNamedInTheCapture() {
        phone()
        val photo = Uri.parse("content://com.google.android.apps.photos.contentprovider/0/1/photo.png")
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42)
        shadowOf(app.contentResolver).registerInputStreamSupplier(photo) { ByteArrayInputStream(png) }
        launch(Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, photo))
        compose.onNodeWithTag("capturePictures").assertIsDisplayed()
        compose.onNodeWithText("1 picture").assertIsDisplayed()
        compose.onNodeWithTag("captureSave").performClick()
        await { stored().isNotEmpty() }
        val capture = stored().single()
        val name = capture.pictures
        assertTrue(name, Regex("[0-9a-f]{64}\\.png").matches(name))
        assertEquals("![](attachments/$name)", capture.text)
        // Stored on the phone before the capture, waiting to upload first (A313, A338).
        runBlocking { assertEquals(false, graph.database.attachments().get(name.substringBefore('.'))!!.uploaded) }
    }

    @Test
    fun aSheetTurnedMidSaveSavesItsCaptureOnceAndCloses() {
        phone()
        val photo = Uri.parse("content://com.google.android.apps.photos.contentprovider/0/1/slow.png")
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 43)
        val reading = CountDownLatch(1)
        val release = CountDownLatch(1)
        shadowOf(app.contentResolver).registerInputStreamSupplier(photo) {
            // A large picture still being read when the phone turns.
            reading.countDown()
            release.await(5, TimeUnit.SECONDS)
            ByteArrayInputStream(png)
        }
        launch(Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_TEXT, "The view").putExtra(Intent.EXTRA_STREAM, photo))
        compose.onNodeWithTag("captureSave").performClick()
        await { reading.count == 0L }
        scenario!!.recreate()
        // The sheet made again shows the save under way, and cannot start a second (S6, A348).
        compose.onNodeWithTag("captureSave").assertIsNotEnabled()
        compose.onNodeWithText("Saving…").assertIsDisplayed()
        release.countDown()
        awaitClosed()
        val capture = stored().single()
        assertTrue(capture.text.startsWith("The view\n\n![](attachments/"))
        assertEquals("Saved to today’s note.", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun textPastedBeyondWhatACaptureHoldsIsCutWithAWord() {
        phone()
        launch(Intent(ShareIntents.ACTION_CAPTURE))
        // 100,000 CJK characters are 300 KB of UTF-8 (S3, A347).
        compose.onNodeWithTag("captureText").performTextReplacement("漢".repeat(100_000))
        await { true }
        compose.onNodeWithText("That is more than a capture can hold, so the end is cut.").assertIsDisplayed()
        // Save stays on screen however long the text (the field gives way).
        compose.onNodeWithTag("captureSave").assertIsDisplayed()
        compose.onNodeWithTag("captureSave").performClick()
        awaitClosed()
        assertTrue(Utf8.size(stored().single().text) <= ShareIntents.MAX_TEXT)
    }

    @Test
    fun nothingIsSavedOnCancel() {
        phone()
        launch(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Something"))
        compose.onNodeWithText("Cancel").performClick()
        awaitClosed()
        assertEquals(0, stored().size)
    }

    @Test
    fun aTapOnTheSheetKeepsItAndATapOutsideCancels() {
        phone()
        launch(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Something"))
        compose.onNodeWithText("Capture to Penmoss").performClick()
        await { true }
        assertEquals(Lifecycle.State.RESUMED, scenario!!.state)
        // Above the sheet, which sits at the bottom.
        compose.onRoot().performTouchInput { click(Offset(centerX, 4f)) }
        awaitClosed()
        assertEquals(0, stored().size)
    }

    @Test
    fun textTypedHereIsThrownAwayOnlyOnceConfirmed() {
        phone()
        launch(CaptureTileService.captureIntent(app))
        compose.onNodeWithTag("captureText").performTextReplacement("Call the vet")
        // Cancel asks first, and Keep editing keeps the sheet and the text.
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
        assertEquals(Lifecycle.State.RESUMED, scenario!!.state)
        compose.onNodeWithTag("captureKeepEditing").performClick()
        compose.onNodeWithText("Discard this capture?").assertDoesNotExist()
        compose.onNodeWithTag("captureText").assert(hasText("Call the vet"))
        // So do Back and a tap outside the sheet.
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
        compose.onNodeWithTag("captureKeepEditing").performClick()
        compose.onRoot().performTouchInput { click(Offset(centerX, 4f)) }
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
        compose.onNodeWithTag("captureDiscard").performClick()
        awaitClosed()
        assertEquals(0, stored().size)
    }

    @Test
    fun anEmptySheetClosesOnBackWithoutAsking() {
        phone()
        launch(CaptureTileService.captureIntent(app))
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        // Nothing typed: it closes at once, with no question.
        awaitClosed()
    }

    @Test
    @Config(qualifiers = "w800dp-h200dp")
    fun onAShortScreenTheSheetIsOneRowWithTheTextAndSaveInView() {
        phone()
        launch(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Something"))
        // A phone on its side with the keyboard up: the text field kept at least one line's height,
        // and Save on screen beside it (A529).
        compose.onNodeWithTag("captureText").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("captureSave").assertIsDisplayed()
        compose.onNodeWithTag("captureInbox").assertIsDisplayed()
        compose.onNodeWithTag("captureSave").performClick()
        awaitClosed()
        assertEquals("Something", stored().single().text)
    }

    @Test
    @Config(qualifiers = "w800dp-h360dp")
    fun withLargeTextOnAShortScreenTheTextKeepsItsWidthAndSaveStaysInView() {
        RuntimeEnvironment.setFontScale(2f)
        phone()
        launch(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Something"))
        // Twice the text size on a phone on its side: everything in one row would leave the text a
        // sliver and clip Save. The destinations move to a second row instead (A529).
        compose.onNodeWithTag("captureText").assertIsDisplayed().assertWidthIsAtLeast(ROW_FIELD_DP.dp)
        compose.onNodeWithTag("captureSave").assertIsDisplayed().assertWidthIsAtLeast(48.dp)
        compose.onNodeWithTag("captureInbox").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithTag("captureSave").performClick()
        awaitClosed()
        assertEquals(listOf("Something" to CaptureRequest.INBOX), stored().map { it.text to it.destination })
    }

    @Test
    fun withNoGitNotebookTheSheetSaysToAddOneAndOpensTheApp() {
        phone(notebook = false)
        launch(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Something"))
        compose.onNodeWithText(NO_NOTEBOOK).assertIsDisplayed()
        compose.onNodeWithTag("captureText").assertDoesNotExist()
        compose.onNodeWithText("Sign In", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("captureOpenApp").performClick()
        awaitClosed()
        assertEquals("app.penmoss.ui.MainActivity", shadowOf(app).nextStartedActivity.component?.className)
        // Nothing was kept anywhere: the app's own database holds no captures.
        assertEquals(0, runBlocking { main.database.captures().all() }.size)
    }

    @Test
    fun theSheetIsInTheShareSheetForTextAndPictures() {
        val pm = app.packageManager
        for (type in listOf("text/plain", "image/jpeg", "image/png")) {
            val targets = pm.queryIntentActivities(Intent(Intent.ACTION_SEND).setType(type), 0).map { it.activityInfo.name }
            assertTrue(type, CaptureActivity::class.java.name in targets)
        }
        val many = pm.queryIntentActivities(Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*"), 0).map { it.activityInfo.name }
        assertTrue(CaptureActivity::class.java.name in many)
        // Not for anything else.
        val video = pm.queryIntentActivities(Intent(Intent.ACTION_SEND).setType("video/mp4"), 0).map { it.activityInfo.name }
        assertTrue(CaptureActivity::class.java.name !in video)
    }
}
