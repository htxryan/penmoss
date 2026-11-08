package app.penmoss.editor

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import app.penmoss.data.Attachments
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/**
 * Pictures from the photo picker (T33, A304), read on the phone so the editor
 * page never gets a file. A type the server takes is kept byte for byte; any
 * other picture Android can read (a HEIC photo from the camera) becomes a JPEG.
 */
object PickedPictures {
    /** JPEG quality for a picture that has to be re-encoded. */
    private const val QUALITY = 90

    /**
     * The longest edge of a re-encoded picture (A314): a 50 MP photo decoded whole is a 200 MB
     * bitmap. Notes show pictures no larger than this anyway.
     */
    const val MAX_EDGE = 4096

    /** The size to decode a picture of this size at: its own, or scaled down to [MAX_EDGE]. */
    fun targetSize(width: Int, height: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= MAX_EDGE || longest <= 0) return width to height
        val scale = MAX_EDGE.toDouble() / longest
        return maxOf(1, (width * scale).toInt()) to maxOf(1, (height * scale).toInt())
    }

    /** The bytes to store for one picked picture, or null when it cannot be read or is too large. */
    fun read(resolver: ContentResolver, uri: Uri): ByteArray? {
        val bytes = try {
            resolver.openInputStream(uri)?.use { readAtMost(it, Attachments.MAX_BYTES + 1) }
        } catch (error: IOException) {
            null
        } catch (error: SecurityException) {
            null
        } catch (error: OutOfMemoryError) {
            null
        } ?: return null
        if (bytes.size > Attachments.MAX_BYTES) return null
        if (Attachments.sniff(bytes) != null) return bytes
        return reencode(resolver, uri)
    }

    private fun reencode(resolver: ContentResolver, uri: Uri): ByteArray? = try {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val (width, height) = targetSize(info.size.width, info.size.height)
            decoder.setTargetSize(width, height)
        }
        ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
            bitmap.recycle()
            out.toByteArray().takeIf { it.size <= Attachments.MAX_BYTES }
        }
    } catch (error: IOException) {
        null
    } catch (error: IllegalArgumentException) {
        null
    } catch (error: OutOfMemoryError) {
        // Too large even scaled down: "a picture could not be read", never the app gone.
        null
    }

    private fun readAtMost(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (out.size() < limit) {
            val read = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
