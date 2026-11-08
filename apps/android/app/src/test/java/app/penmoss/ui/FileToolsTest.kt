package app.penmoss.ui

import android.content.Intent
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.FileRequest
import app.penmoss.editor.FormatState
import app.penmoss.editor.OpenedFiles
import app.penmoss.editor.WebPictureSetting
import app.penmoss.engine.bridge.FileAction
import app.penmoss.ui.settings.StorageSection
import app.penmoss.ui.settings.StorageUse
import app.penmoss.ui.settings.formatBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Files out of the phone and the storage they take (T40 P8, ED12, ED13). */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FileToolsTest {
    @get:Rule
    val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test
    fun namesACopyForPeopleWithItsExtension() {
        assertEquals("Lease.pdf", OpenedFiles.safeName("Lease.pdf", "pdf"))
        assertEquals("Lease.PDF", OpenedFiles.safeName("Lease.PDF", "pdf"))
        assertEquals("Q3 report.pdf", OpenedFiles.safeName("Q3 report", "pdf"))
        // Nothing a file system refuses, no hidden or path names, never empty.
        assertEquals("a b c.csv", OpenedFiles.safeName("a/b\\c", "csv"))
        assertEquals("etc passwd.bin", OpenedFiles.safeName("../../etc/passwd", "bin"))
        assertFalse(OpenedFiles.safeName(".hidden", "txt").startsWith("."))
        assertEquals("file.zip", OpenedFiles.safeName("  ", "zip"))
        assertTrue(OpenedFiles.safeName("x".repeat(400), "csv").length <= 124)
    }

    @Test
    fun tellsOtherAppsTheTypeTheServerWouldServe() {
        assertEquals("application/pdf", OpenedFiles.viewType("pdf"))
        assertEquals("image/png", OpenedFiles.viewType("png"))
        assertEquals("application/octet-stream", OpenedFiles.viewType("qqq"))
    }

    @Test
    fun opensACopyThroughTheFileProviderWithReadAccessOnly() {
        val stored = File(context.filesDir, "attachments/${"c".repeat(64)}.pdf").apply {
            parentFile!!.mkdirs()
            writeText("%PDF-1.7")
        }
        val viewer = Intent(Intent.ACTION_VIEW).setType("application/pdf")
        shadowOf(context.packageManager).addResolveInfoForIntent(
            viewer,
            android.content.pm.ResolveInfo().apply {
                activityInfo = android.content.pm.ActivityInfo().apply {
                    packageName = "com.example.viewer"
                    name = "Viewer"
                }
            },
        )
        assertTrue(OpenedFiles.open(context, stored, "Lease", "pdf"))
        val started = shadowOf(context).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals("application/pdf", started.type)
        assertEquals("content", started.data!!.scheme)
        assertEquals("${context.packageName}.files", started.data!!.authority)
        assertTrue(started.data!!.path!!.endsWith("/Lease.pdf"))
        assertTrue(started.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertFalse(started.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
        // The copy is in the shared cache folder, never the files kept for upload.
        assertTrue(File(context.cacheDir, "shared/${"c".repeat(64)}/Lease.pdf").isFile)
    }

    @Test
    fun saveACopyAsksForTheNameAndTypeAndWritesTheFile() {
        val intent = OpenedFiles.SaveCopy().createIntent(context, "Budget.csv" to "text/csv")
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertEquals("text/csv", intent.type)
        assertEquals("Budget.csv", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals(null, OpenedFiles.SaveCopy().parseResult(android.app.Activity.RESULT_CANCELED, Intent()))

        val source = File.createTempFile("budget", ".csv").apply { writeText("a,b") }
        val target = File.createTempFile("saved", ".csv")
        assertTrue(OpenedFiles.save(context.contentResolver, source, android.net.Uri.fromFile(target)))
        assertEquals("a,b", target.readText())
    }

    @Test
    fun saveACopyWritesTheFileThoughTheActivityWasRecreatedWhileItsPickerWasOpen() {
        // Review PS4: the picker made the document already; it must not be left empty.
        val db = app.penmoss.data.PenmossDatabase.inMemory(context)
        val attachments = app.penmoss.data.Attachments(
            db.attachments(),
            File(context.filesDir, "save-test"),
            File(context.cacheDir, "save-test"),
            app.penmoss.FakeApi(),
        )
        val csv = "a,b\n1,2\n".toByteArray()
        val path = kotlinx.coroutines.runBlocking { attachments.addFile(csv.inputStream(), "Budget.csv", "n") }
        val files = app.penmoss.editor.NoteFiles(
            "n",
            send = {},
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            store = attachments,
            webPictures = null,
            showing = { true },
            notify = {},
        )
        val launched = java.util.concurrent.CopyOnWriteArrayList<Int>()
        val registry = object : androidx.activity.result.ActivityResultRegistry() {
            override fun <I, O> onLaunch(
                requestCode: Int,
                contract: androidx.activity.result.contract.ActivityResultContract<I, O>,
                input: I,
                options: androidx.core.app.ActivityOptionsCompat?,
            ) {
                launched += requestCode
            }
        }
        val owner = object : androidx.activity.result.ActivityResultRegistryOwner {
            override val activityResultRegistry = registry
        }
        val restoration = androidx.compose.ui.test.junit4.StateRestorationTester(compose)
        restoration.setContent {
            androidx.compose.runtime.CompositionLocalProvider(androidx.activity.compose.LocalActivityResultRegistryOwner provides owner) {
                val snackbar = androidx.compose.runtime.remember { androidx.compose.material3.SnackbarHostState() }
                rememberNoteFiles(files, androidx.compose.runtime.rememberCoroutineScope(), snackbar) {}
                androidx.compose.material3.SnackbarHost(snackbar)
            }
        }
        files.onMessage(app.penmoss.engine.bridge.ParityFromEditor.OpenFile("n", path, "Budget.csv", FileAction.SAVE))
        compose.waitUntil(5_000) { launched.isNotEmpty() }
        // Rotated, or dark mode switched, while Ryan picks where the copy goes.
        restoration.emulateSavedInstanceStateRestore()
        val target = File.createTempFile("saved", ".csv")
        compose.runOnIdle { registry.dispatchResult(launched.first(), android.net.Uri.fromFile(target)) }
        compose.waitUntil(5_000) { target.length() == csv.size.toLong() }
        assertEquals("a,b\n1,2\n", target.readText())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Saved a copy.").fetchSemanticsNodes().isNotEmpty() }
        db.close()
    }

    @Test
    fun saysWhenAFileIsNotOnThePhoneInTheWebsWords() {
        assertEquals(
            "“Lease.pdf” is not available yet: it downloads once online.",
            unavailable(FileRequest("attachments/x.pdf", "Lease.pdf", FileAction.OPEN)),
        )
    }

    @Test
    fun theBarAttachesAFile() {
        var attached = 0
        compose.setContent {
            PenmossTheme { FormatBar(FormatState(), onCommand = {}, onLink = {}, onPicture = {}, onAttach = { attached++ }) }
        }
        compose.onNodeWithContentDescription("Attach a File").performScrollTo().performClick()
        assertEquals(1, attached)
    }

    @Test
    fun storageShowsTheSpaceUsedAndTheWebPicturesSetting() {
        val chosen = mutableListOf<WebPictureSetting>()
        var cleared = 0
        var use by mutableStateOf<StorageUse?>(null)
        var setting by mutableStateOf(WebPictureSetting.ON)
        compose.setContent {
            PenmossTheme {
                androidx.compose.foundation.layout.Column(
                    androidx.compose.ui.Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState()),
                ) {
                    StorageSection(use, setting, onWebPictures = { chosen += it }, onClearWebPictures = { cleared++ })
                }
            }
        }
        compose.onNodeWithTag("storageFiles", useUnmergedTree = true).assertTextEquals("Counting…")
        compose.onNodeWithTag("clearWebPictures").assertIsNotEnabled()
        use = StorageUse(files = 12L * 1024 * 1024, webPictures = 1536)
        compose.onNodeWithTag("storageFiles", useUnmergedTree = true).assertTextEquals("12 MB")
        compose.onNodeWithTag("storageWebPictures", useUnmergedTree = true).assertTextEquals("1.5 KB kept to show again")
        compose.onNodeWithTag("clearWebPictures").performClick()
        assertEquals(1, cleared)
        compose.onNodeWithTag("webPictures-on").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        compose.onNodeWithTag("webPictures-wifi").performScrollTo().performClick()
        compose.onNodeWithTag("webPictures-off").performScrollTo().performClick()
        assertEquals(listOf(WebPictureSetting.WIFI_ONLY, WebPictureSetting.OFF), chosen)
        setting = WebPictureSetting.WIFI_ONLY
        compose.onNodeWithTag("webPictures-wifi").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
    }

    @Test
    fun formatsSizesAsCoreDoes() {
        assertEquals("512 B", formatBytes(512))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("1 KB", formatBytes(1024))
        assertEquals("20 MB", formatBytes(20L * 1024 * 1024))
        assertNotNull(formatBytes(0))
    }
}
