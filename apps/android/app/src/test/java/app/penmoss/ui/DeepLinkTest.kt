package app.penmoss.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import app.penmoss.capture.CaptureActivity
import app.penmoss.engine.notes.DeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Deep links on the phone (T40 P7, PL5, A476): the manifest sends `penmoss://note/<id>` to the
 * app and `penmoss://capture` to the capture sheet, the app reads them as the Mac app does, and a
 * link only ever opens.
 */
@RunWith(RobolectricTestRunner::class)
class DeepLinkTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val id = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"

    private fun view(link: String) = Intent(Intent.ACTION_VIEW, Uri.parse(link))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(context.packageName)

    private fun handlers(link: String) =
        context.packageManager.queryIntentActivities(view(link), 0).map { it.activityInfo.name }

    @Test
    fun theManifestSendsNoteLinksToTheAppAndCaptureLinksToTheSheet() {
        assertEquals(listOf(MainActivity::class.java.name), handlers("penmoss://note/$id"))
        assertEquals(listOf(CaptureActivity::class.java.name), handlers("penmoss://capture"))
        // No sign-in callback and no App Link since T59 (A1042): nothing else is claimed.
        assertTrue(handlers("penmoss://auth/callback").isEmpty())
        assertTrue(handlers("penmoss://settings/devices").isEmpty())
        assertTrue(handlers("https://app.penmoss.app/notes/$id").isEmpty())
        assertTrue(handlers("https://app.penmoss.app/android/debug/callback?code=c&state=s").isEmpty())
        assertTrue(handlers("https://app.penmoss.app/android/callback?code=c&state=s").isEmpty())
        assertTrue(handlers("https://app.penmoss.app/").isEmpty())
    }

    /** No filter verifies a host: the app claims no web address at all (A1042). */
    @Test
    fun theManifestClaimsNoWebAddress() {
        val main = context.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName), 0)
        assertEquals(listOf(MainActivity::class.java.name), main.map { it.activityInfo.name })
        for (link in listOf("https://app.penmoss.app/android/debug/callback", "https://api.penmoss.app/", "http://app.penmoss.app/")) {
            assertTrue(link, handlers(link).isEmpty())
        }
    }

    @Test
    fun theAppReadsAViewLinkOnly() {
        assertEquals(DeepLink.Note(id), deepLinkOf(view("penmoss://note/${id.lowercase()}")))
        assertEquals(DeepLink.Capture, deepLinkOf(view("penmoss://capture")))
        assertNull(deepLinkOf(view("penmoss://note/not-an-id")))
        assertNull(deepLinkOf(view("penmoss://auth/callback?code=x")))
        // A link sent any other way than VIEW is not a deep link.
        assertNull(deepLinkOf(Intent(Intent.ACTION_SEND, Uri.parse("penmoss://note/$id"))))
        assertNull(deepLinkOf(null))
    }

    @Test
    fun aNoteLinkWaitsToBeOpenedAndALaterOneReplacesIt() {
        val inbox = DeepLinkInbox()
        assertNull(inbox.note.value)
        inbox.offer(id)
        assertEquals(id, inbox.note.value)
        inbox.offer("01JD2Z7Q8R4T6Y8W0E2R4T6YB2")
        // Opening the first one late leaves the newer link waiting.
        inbox.opened(id)
        assertEquals("01JD2Z7Q8R4T6Y8W0E2R4T6YB2", inbox.note.value)
        inbox.opened("01JD2Z7Q8R4T6Y8W0E2R4T6YB2")
        assertNull(inbox.note.value)
    }
}
