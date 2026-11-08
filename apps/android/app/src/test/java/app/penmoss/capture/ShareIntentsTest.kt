package app.penmoss.capture

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What the share sheet brings, read as a capture (T34, A339): Chrome's web
 * pages, other apps' text, Photos' pictures, and what is refused.
 */
@RunWith(AndroidJUnit4::class)
class ShareIntentsTest {
    /** This build's application id, whatever it is (A370): never hard-coded. */
    private val own: String = ApplicationProvider.getApplicationContext<Context>().packageName

    private fun send(type: String, text: String? = null, subject: String? = null) =
        Intent(Intent.ACTION_SEND).setType(type).apply {
            text?.let { putExtra(Intent.EXTRA_TEXT, it) }
            subject?.let { putExtra(Intent.EXTRA_SUBJECT, it) }
        }

    private fun draft(intent: Intent) = ShareIntents.draftOf(intent, own)

    @Test
    fun aWebPageFromChromeIsItsTitleThenItsAddress() {
        // Chrome shares the address as the text and the page's title as the subject.
        val shared = send("text/plain", "https://penmoss.app/android?ref=share", "Penmoss for Android")
        assertEquals(CaptureDraft("Penmoss for Android\n<https://penmoss.app/android?ref=share>"), draft(shared))
    }

    @Test
    fun aPageSharedAsTitleAndAddressInOneTextKeepsBoth() {
        val shared = send("text/plain", "Check this out: https://example.com/a-post.")
        assertEquals(CaptureDraft("Check this out\n<https://example.com/a-post>"), draft(shared))
    }

    @Test
    fun anAddressAloneIsTitledByItsHost() {
        assertEquals(CaptureDraft("example.com\n<https://www.example.com/x>"), draft(send("text/plain", "https://www.example.com/x")))
    }

    @Test
    fun theSubjectAndTheWordsAroundTheAddressAreBothKept() {
        val shared = send("text/plain", "Read later https://example.com/p", "A long read")
        assertEquals(CaptureDraft("A long read\n<https://example.com/p>\nRead later"), draft(shared))
    }

    @Test
    fun plainTextIsKeptAsItIsWithItsSubjectFirst() {
        assertEquals(CaptureDraft("Buy oat milk\nand bread"), draft(send("text/plain", "Buy oat milk\nand bread")))
        assertEquals(CaptureDraft("Groceries\nBuy oat milk"), draft(send("text/plain", "Buy oat milk", "Groceries")))
        // A subject the text already starts with is not repeated.
        assertEquals(CaptureDraft("Groceries: oat milk"), draft(send("text/plain", "Groceries: oat milk", "Groceries")))
    }

    @Test
    fun aPictureFromPhotosComesWithAnyText() {
        val photo = Uri.parse("content://com.google.android.apps.photos.contentprovider/0/1/photo.jpg")
        val shared = send("image/jpeg", "The view").putExtra(Intent.EXTRA_STREAM, photo)
        assertEquals(CaptureDraft("The view", listOf(photo)), draft(shared))
        assertEquals(CaptureDraft("", listOf(photo)), draft(send("image/*").putExtra(Intent.EXTRA_STREAM, photo)))
    }

    @Test
    fun severalPicturesComeAtMostTenAtATime() {
        val photos = (1..12).map { Uri.parse("content://media/external/images/media/$it") }
        val shared = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(photos))
        assertEquals(photos.take(ShareIntents.MAX_PICTURES), draft(shared)!!.pictures)
    }

    @Test
    fun picturesAreReadOnlyFromAddressesAnotherAppGranted() {
        // Never a file path, and never one of this app's own providers: a share must not make the
        // phone store and upload its own files (the token vault, the database).
        val refused = listOf(
            Uri.parse("file:///data/user/0/$own/shared_prefs/penmoss.vault.xml"),
            Uri.parse("content://$own/files/x"),
            Uri.parse("content://$own.androidx-startup/x"),
            Uri.parse("https://example.com/picture.png"),
        )
        for (uri in refused) {
            assertNull(uri.toString(), draft(send("image/png").putExtra(Intent.EXTRA_STREAM, uri)))
        }
        val shared = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(refused + Uri.parse("content://media/external/images/media/9")))
        assertEquals(listOf(Uri.parse("content://media/external/images/media/9")), draft(shared)!!.pictures)
    }

    @Test
    fun theTileAndTheWidgetOpenAnEmptyCapture() {
        assertEquals(CaptureDraft(), draft(Intent(ShareIntents.ACTION_CAPTURE)))
    }

    @Test
    fun nothingToCaptureIsNoCapture() {
        assertNull(draft(send("text/plain", "   ")))
        assertNull(draft(send("text/plain")))
        assertNull(draft(Intent(Intent.ACTION_VIEW)))
        assertNull(draft(Intent(Intent.ACTION_SEND_MULTIPLE).setType("video/*")))
    }

    @Test
    fun aVeryLongShareIsCut() {
        val long = "x".repeat(ShareIntents.MAX_TEXT + 500)
        assertEquals(ShareIntents.MAX_TEXT, draft(send("text/plain", long))!!.text.length)
    }

    @Test
    fun aShareIsCutByItsUtf8BytesNotItsCharacters() {
        // 100,000 CJK characters are 300 KB: over what the server takes however few the characters (A347).
        val text = draft(send("text/plain", "漢".repeat(100_000)))!!.text
        assertTrue(Utf8.size(text) <= ShareIntents.MAX_TEXT)
        assertEquals(ShareIntents.MAX_TEXT / 3, text.length)
        assertTrue(ShareIntents.MAX_TEXT < 256 * 1024)
    }

    @Test
    fun aCutNeverSplitsACharacter() {
        val emoji = draft(send("text/plain", "a" + "😀".repeat(60_000)))!!.text
        assertTrue(Utf8.size(emoji) <= ShareIntents.MAX_TEXT)
        assertFalse(Character.isHighSurrogate(emoji.last()))
        assertEquals("ab", Utf8.cut("ab😀", 5))
        assertEquals("ab😀", Utf8.cut("ab😀", 6))
        assertEquals(6, Utf8.size("ab😀"))
        assertEquals(3, Utf8.size("é€".substring(0, 1) + "a"))
    }

    @Test
    fun aProviderThisAppServesIsRefusedWhateverItsName() {
        // A provider of this app's under a name that does not start with the package (A349).
        val ours = Uri.parse("content://androidx.core.content.FileProvider.penmoss/files/vault")
        val owners = mapOf("androidx.core.content.FileProvider.penmoss" to own, "media" to "com.android.providers.media.module")
        val shared = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(listOf(ours, Uri.parse("content://media/external/images/media/9"))))
        val read = ShareIntents.draftOf(shared, own) { owners[it] }!!
        assertEquals(listOf(Uri.parse("content://media/external/images/media/9")), read.pictures)
        assertNull(ShareIntents.draftOf(send("image/png").putExtra(Intent.EXTRA_STREAM, ours), own) { owners[it] })
        // A provider the system cannot name is read as before.
        assertTrue(ShareIntents.readable(Uri.parse("content://media/external/images/media/9"), own) { throw SecurityException("no") })
    }
}
