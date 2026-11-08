package app.penmoss.editor

import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.FileProvider
import app.penmoss.data.Attachments
import app.penmoss.engine.bridge.FileLimits
import java.io.File
import java.io.IOException

/**
 * Files out of and into the phone for the editor (T40 P8, ED12): a chip's Open hands the file to
 * the app Android picks for it through a [FileProvider] (a PDF opens in Android's viewer), Save a
 * copy writes it where the person picks (`ACTION_CREATE_DOCUMENT`), and the document picker's
 * files are read here, so the page never gets a file.
 */
object OpenedFiles {
    /** The [FileProvider]'s authority, as the manifest declares it. */
    fun authority(context: Context) = "${context.packageName}.files"

    /** Where shared copies go: the cache, under a folder the provider shares (`file_paths.xml`). */
    private const val SHARED = "shared"

    /**
     * The name a copy is shared or saved under: the chip's name with anything a file system
     * refuses taken out, ending in the stored extension, and never empty.
     */
    fun safeName(name: String, ext: String): String {
        val clean = name.replace(Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]"), " ").trimStart('.', ' ').take(120).trim()
        val base = clean.ifEmpty { "file" }
        return if (base.lowercase().endsWith(".$ext")) base else "$base.$ext"
    }

    /** The type another app is told the file is: a picture's or a PDF's, else what its extension says. */
    fun viewType(ext: String): String {
        val stored = Attachments.typeOf(ext)
        if (stored != Attachments.GENERIC_TYPE) return stored
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: Attachments.GENERIC_TYPE
    }

    /** A copy of [file] named for people, in the shared cache folder; null when it cannot be made. */
    fun sharedCopy(context: Context, file: File, name: String, ext: String): File? = try {
        // A folder per file: two files of the same name never overwrite each other.
        val folder = File(File(context.cacheDir, SHARED), file.nameWithoutExtension).apply { mkdirs() }
        val copy = File(folder, safeName(name, ext))
        if (!(copy.isFile && copy.length() == file.length())) file.copyTo(copy, overwrite = true)
        copy
    } catch (error: IOException) {
        null
    }

    /**
     * Opens [file] in the app Android picks for its type; false when no app on the phone opens it
     * (the note screen then offers Save a copy).
     */
    fun open(context: Context, file: File, name: String, ext: String): Boolean {
        val copy = sharedCopy(context, file, name, ext) ?: return false
        val uri = FileProvider.getUriForFile(context, authority(context), copy)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, viewType(ext))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (error: ActivityNotFoundException) {
            false
        } catch (error: SecurityException) {
            false
        }
    }

    /** Writes a copy where Save a copy put it; false when it could not be written. */
    fun save(resolver: ContentResolver, file: File, target: Uri): Boolean = try {
        resolver.openOutputStream(target, "wt")?.use { out -> file.inputStream().use { it.copyTo(out) } } != null
    } catch (error: IOException) {
        false
    } catch (error: SecurityException) {
        false
    }

    /** Deletes the document Save a copy's picker made, when the copy could not be written (review PS4). */
    fun discard(resolver: ContentResolver, target: Uri) {
        try {
            DocumentsContract.deleteDocument(resolver, target)
        } catch (error: Exception) {
            // Not a provider's document, or gone already: nothing to leave behind.
        }
    }

    /** Save a copy's picker: the name and type to suggest, and where the person put it (or null). */
    class SaveCopy : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
    }

    /** One file from the document picker: its name, read only when its turn comes (review PS1). */
    fun picked(resolver: ContentResolver, uri: Uri): PickedFile {
        val name = displayName(resolver, uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        return PickedFile(name.take(FileLimits.MAX_NAME)) { resolver.openInputStream(uri) }
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    } catch (error: Exception) {
        null
    }
}
