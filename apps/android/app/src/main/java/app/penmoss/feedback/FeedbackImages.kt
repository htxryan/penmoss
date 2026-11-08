package app.penmoss.feedback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.File
import java.io.IOException

/**
 * Feedback's screenshots (T49, A792): PNG, JPEG, WebP or GIF, 10 MB each before compression, at
 * most 6. Before upload each is scaled down to 2560 px on its long side and encoded again: a PNG
 * stays PNG, anything else becomes JPEG at 85.
 */
object FeedbackImages {
    /** The types GitHub attaches, and each one's extension (core's FEEDBACK_IMAGE_TYPES). */
    val TYPES = mapOf("image/png" to "png", "image/jpeg" to "jpg", "image/gif" to "gif", "image/webp" to "webp")

    fun accepts(mime: String?): Boolean = mime?.lowercase()?.substringBefore(';')?.trim() in TYPES

    /** Why an image cannot be added, or null when it can. */
    fun refusal(mime: String?, bytes: Long, count: Int): String? = when {
        count >= FeedbackLimits.SCREENSHOTS -> "At most ${FeedbackLimits.SCREENSHOTS} screenshots"
        !accepts(mime) -> "Screenshots must be PNG, JPEG, WebP or GIF images"
        bytes > FeedbackLimits.SCREENSHOT_BYTES -> "That image is over 10 MB"
        bytes <= 0 -> "That image is empty"
        else -> null
    }

    /** How an image is encoded for upload: PNG stays PNG, the rest JPEG. */
    enum class Encoding(val mime: String, val ext: String) {
        PNG("image/png", "png"),
        JPEG("image/jpeg", "jpg"),
    }

    fun encodingFor(mime: String?): Encoding = if (mime?.lowercase()?.startsWith("image/png") == true) Encoding.PNG else Encoding.JPEG

    /** The size an image is scaled to: its own when it fits [longSide], else its long side at [longSide], aspect kept. */
    fun scaledSize(width: Int, height: Int, longSide: Int = FeedbackLimits.LONG_SIDE): Pair<Int, Int> {
        require(width > 0 && height > 0) { "empty image" }
        val long = maxOf(width, height)
        if (long <= longSide) return width to height
        val scale = longSide.toDouble() / long
        val w = if (width >= height) longSide else maxOf(1, Math.round(width * scale).toInt())
        val h = if (height > width) longSide else maxOf(1, Math.round(height * scale).toInt())
        return w to h
    }

    /**
     * The largest power-of-two step to decode at that still leaves the image at least as large as
     * [scaledSize] (so the final scale only ever shrinks), keeping memory low for a large photo.
     */
    fun sampleSize(width: Int, height: Int, longSide: Int = FeedbackLimits.LONG_SIDE): Int {
        val (w, h) = scaledSize(width, height, longSide)
        var sample = 1
        while (width / (sample * 2) >= w && height / (sample * 2) >= h) sample *= 2
        return sample
    }

    /** A screenshot made ready to upload: its file, type and extension. */
    data class Prepared(val file: File, val mime: String, val ext: String)

    /**
     * Scales [source] down and encodes it again into [dir] as `screenshot-<n>.<ext>`
     * ([Encoding]); an image's EXIF rotation is applied first. Throws [IOException] when it cannot
     * be read.
     */
    fun prepare(source: File, mime: String, dir: File, index: Int): Prepared {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Not an image")
        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }
        var bitmap = BitmapFactory.decodeFile(source.path, options) ?: throw IOException("Not an image")
        bitmap = rotated(bitmap, source)
        val (w, h) = scaledSize(bitmap.width, bitmap.height)
        if (w != bitmap.width || h != bitmap.height) bitmap = Bitmap.createScaledBitmap(bitmap, w, h, true).also { if (it !== bitmap) bitmap.recycle() }
        val encoding = encodingFor(mime)
        if (encoding == Encoding.JPEG && bitmap.hasAlpha()) {
            // JPEG has no transparency: what was transparent shows white, not black.
            val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            Canvas(flat).apply {
                drawColor(Color.WHITE)
                drawBitmap(bitmap, 0f, 0f, null)
            }
            bitmap.recycle()
            bitmap = flat
        }
        dir.mkdirs()
        val out = File(dir, "screenshot-$index.${encoding.ext}")
        out.outputStream().use { stream ->
            val format = if (encoding == Encoding.PNG) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
            if (!bitmap.compress(format, FeedbackLimits.JPEG_QUALITY, stream)) throw IOException("Could not encode the image")
        }
        bitmap.recycle()
        return Prepared(out, encoding.mime, encoding.ext)
    }

    /** A small thumbnail of [file] for the form, or null when it cannot be read. */
    fun thumbnail(file: File, side: Int = 256): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) {
            null
        } else {
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= side && bounds.outHeight / (sample * 2) >= side) sample *= 2
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.let { rotated(it, file) }
        }
    } catch (error: Exception) {
        null
    } catch (error: OutOfMemoryError) {
        null
    }

    private fun rotated(bitmap: Bitmap, source: File): Bitmap {
        val degrees = try {
            when (ExifInterface(source.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } catch (error: Exception) {
            0f
        }
        if (degrees == 0f) return bitmap
        val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees) }, true)
        if (turned !== bitmap) bitmap.recycle()
        return turned
    }
}
