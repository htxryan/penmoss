package app.penmoss.feedback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

/** Screenshots are scaled to 2560 px on the long side and encoded again before upload (T49, A792). */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FeedbackImagesTest {
    private val dir = Files.createTempDirectory("images").toFile()

    @After
    fun clean() {
        dir.deleteRecursively()
    }

    private fun image(name: String, width: Int, height: Int, format: Bitmap.CompressFormat): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(40, 120, 60)) }
        return File(dir, name).apply { outputStream().use { bitmap.compress(format, 90, it) } }
    }

    private fun size(file: File) = BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { BitmapFactory.decodeFile(file.path, it) }.let { it.outWidth to it.outHeight }

    @Test
    fun aLargePngStaysPngAtTheLongSide() {
        val prepared = FeedbackImages.prepare(image("big.png", 3000, 6000, Bitmap.CompressFormat.PNG), "image/png", File(dir, "out"), 1)
        assertEquals("image/png", prepared.mime)
        assertEquals("screenshot-1.png", prepared.file.name)
        assertEquals(1280 to 2560, size(prepared.file))
    }

    @Test
    fun anythingElseBecomesJpegAndASmallImageKeepsItsSize() {
        val prepared = FeedbackImages.prepare(image("photo.webp", 800, 600, Bitmap.CompressFormat.WEBP_LOSSLESS), "image/webp", File(dir, "out"), 2)
        assertEquals("image/jpeg", prepared.mime)
        assertEquals("screenshot-2.jpg", prepared.file.name)
        assertEquals(800 to 600, size(prepared.file))
        val bytes = prepared.file.readBytes()
        assertTrue(bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte())
    }

    @Test
    fun aDraftRefusesAnImageOver10Mb() {
        val drafts = FeedbackDrafts(File(dir, "draft")) { "id" }
        assertNull(drafts.addImage(ByteArrayInputStream(ByteArray((FeedbackLimits.SCREENSHOT_BYTES + 1).toInt())), "image/png"))
        assertEquals(0, File(dir, "draft").listFiles()?.size ?: 0)
        val kept = drafts.addImage(ByteArrayInputStream(byteArrayOf(1, 2, 3)), "image/gif")!!
        assertTrue(kept.file.endsWith(".gif"))
        assertNull(drafts.addImage(ByteArrayInputStream(byteArrayOf(1)), "image/heic"))
    }
}
