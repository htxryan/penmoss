package app.penmoss.data

import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.UploadInterrupted
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FileLimits
import app.penmoss.engine.bridge.StoredFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** A picture this phone will not store, with the reason to show. */
class PictureRefused(message: String) : Exception(message)

/** Where the editor's pictures go (A304): the controller's view of [Attachments]. */
interface PictureStore {
    /** Stores picture bytes picked on this phone and returns the path the note holds. */
    suspend fun add(bytes: ByteArray, noteId: String?): String

    /** Stores bytes the editor page hashed, only if they are what `path` names; null if not. */
    suspend fun addFromPage(path: String, bytes: ByteArray, noteId: String): String?
}

/** Where the editor's files go (T40 P8, ED12): pictures and any other file, as on the web (T13). */
interface FileStore : PictureStore {
    /**
     * Stores a file picked on this phone, streamed from [input] to disk (never held whole), and
     * returns the path the note holds.
     */
    suspend fun addFile(input: InputStream, name: String, noteId: String?): String

    /** Stores a file the editor page hashed, only if `path` is what its bytes and name give; null if not. */
    suspend fun addFileFromPage(path: String, name: String, bytes: ByteArray, noteId: String): String?

    /** A stored file's size and type, from this phone's own record; null when unknown. */
    suspend fun info(path: String): StoredFile?

    /** The file's bytes on this phone, fetched with the device token if it lacks them; null if not had. */
    suspend fun document(path: String): File?
}

/**
 * Pictures on the phone (T33, A304), content-addressed as on the server
 * (`attachments/<sha256>.<ext>`, A30). One added here (pasted, or from the
 * photo picker) is kept in the app's files until it is uploaded, and after:
 * it is how the note shows offline. One the note names but the phone lacks
 * is fetched with the device token when the editor shows it, and cached
 * where Android may clear it. The editor page never sees the token: it
 * asks for `/attachments/<sha256>.<ext>` on its own origin, which the
 * editor's WebView answers from here.
 *
 * Other files (T40 P8, ED12) are kept, uploaded and fetched the same way, by
 * the same queue: a file never reaches the page, which only names it; it is
 * read here when a chip's Open or Save a copy asks.
 */
class Attachments(
    private val dao: AttachmentDao,
    /** Pictures added here. */
    private val dir: File,
    /** Pictures fetched to show. */
    private val cache: File,
    private val api: PenmossApi,
    /** A picture was added: upload it soon. */
    private val onAdded: () -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    /** Whether the network is metered now (mobile data): files over [LARGE_UPLOAD] wait for Wi-Fi. */
    private val metered: () -> Boolean = { false },
) : FileStore {
    override suspend fun add(bytes: ByteArray, noteId: String?): String = withContext(Dispatchers.IO) {
        if (bytes.size > MAX_BYTES) throw PictureRefused("Pictures over 50 MB cannot be added")
        val ext = sniff(bytes) ?: throw PictureRefused("Only PNG, JPEG, GIF, WebP and AVIF pictures can be added")
        store(sha256(bytes), ext, bytes, noteId)
    }

    override suspend fun addFromPage(path: String, bytes: ByteArray, noteId: String): String? =
        withContext(Dispatchers.IO) {
            val (sha, ext) = BridgeProtocol.ATTACHMENT_PATH.matchEntire(path)?.destructured ?: return@withContext null
            // The page is not trusted to name the bytes: the path must be their hash and type.
            if (bytes.size > MAX_BYTES || sha256(bytes) != sha || sniff(bytes) != ext) return@withContext null
            store(sha, ext, bytes, noteId)
        }

    override suspend fun addFile(input: InputStream, name: String, noteId: String?): String = withContext(Dispatchers.IO) {
        dir.mkdirs()
        // Streamed through the hash to a file of its own, then named for its hash and type (review PS1).
        val partial = File.createTempFile("picked", ".part", dir)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val head = ByteArray(SNIFF_BYTES)
            var headSize = 0
            var size = 0L
            val buffer = ByteArray(64 * 1024)
            partial.outputStream().use { out ->
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    size += read
                    if (size > MAX_BYTES) throw PictureRefused("“$name” is over 50 MB, the largest file Penmoss stores")
                    if (headSize < head.size) {
                        val taken = minOf(read, head.size - headSize)
                        System.arraycopy(buffer, 0, head, headSize, taken)
                        headSize += taken
                    }
                    digest.update(buffer, 0, read)
                    out.write(buffer, 0, read)
                }
            }
            val sha = hex(digest.digest())
            val ext = extensionFor(head.copyOf(headSize), name)
            val file = File(dir, "$sha.$ext")
            if (!(file.isFile && file.length() == size) && !partial.renameTo(file) && !(file.isFile && file.length() == size)) {
                throw IOException("Could not store ${file.name}")
            }
            record(sha, ext, size, noteId)
        } finally {
            partial.delete()
        }
    }

    override suspend fun addFileFromPage(path: String, name: String, bytes: ByteArray, noteId: String): String? =
        withContext(Dispatchers.IO) {
            if (bytes.size > MAX_BYTES || !FileLimits.PATH.matches(path)) return@withContext null
            // The page is not trusted to name the bytes: the path must be the one they and the name give.
            val sha = sha256(bytes)
            val ext = extensionFor(bytes, name)
            if (path != "attachments/$sha.$ext") return@withContext null
            store(sha, ext, bytes, noteId)
        }

    override suspend fun info(path: String): StoredFile? {
        val (sha, ext) = FileLimits.PATH.matchEntire(path)?.destructured ?: return null
        val row = dao.get(sha)?.takeIf { it.ext == ext }
        if (row != null) return StoredFile(row.size, typeOf(ext))
        // Fetched to open before: the copy in the cache says as much.
        File(cache, "$sha.$ext").takeIf { it.isFile }?.let { return StoredFile(it.length(), typeOf(ext)) }
        // Added on another device: the server says, without the bytes, as the web asks (review PS3).
        sizes[sha]?.let { return StoredFile(it, typeOf(ext)) }
        val size = try {
            api.attachmentSize(sha)
        } catch (error: IOException) {
            null
        } ?: return null
        sizes[sha] = size
        return StoredFile(size, typeOf(ext))
    }

    /** Sizes the server gave for files this phone lacks: asked once each. */
    private val sizes = ConcurrentHashMap<String, Long>()

    override suspend fun document(path: String): File? {
        val (sha, ext) = FileLimits.PATH.matchEntire(path)?.destructured ?: return null
        File(dir, "$sha.$ext").takeIf { it.isFile }?.let { return it }
        File(cache, "$sha.$ext").takeIf { it.isFile }?.let { return it }
        return withContext(Dispatchers.IO) {
            try {
                fetching.withPermit {
                    File(cache, "$sha.$ext").takeIf { it.isFile } ?: run {
                        val bytes = api.attachment(sha)
                        // Content-addressed: what came back must be what was asked for, of the type its path says.
                        if (sha256(bytes) != sha || !matchesExtension(bytes, ext)) return@withPermit null
                        File(cache, "$sha.$ext").also { write(it, bytes) }
                    }
                }
            } catch (error: IOException) {
                null
            }
        }
    }

    private suspend fun store(sha: String, ext: String, bytes: ByteArray, noteId: String?): String {
        write(File(dir, "$sha.$ext"), bytes)
        return record(sha, ext, bytes.size.toLong(), noteId)
    }

    /** Records a file now in [dir] as this phone's, to upload; returns the path the note holds. */
    private suspend fun record(sha: String, ext: String, size: Long, noteId: String?): String {
        val existing = dao.get(sha)
        if (existing == null || !existing.local) {
            dao.put(
                AttachmentEntity(
                    sha256 = sha,
                    ext = ext,
                    size = size,
                    noteId = noteId,
                    local = true,
                    uploaded = existing?.uploaded ?: false,
                    createdAt = now(),
                ),
            )
        }
        File(cache, "$sha.$ext").delete()
        onAdded()
        return "attachments/$sha.$ext"
    }

    /** Fetches at a time: a note naming many large pictures must not take every WebView request thread. */
    private val fetching = Semaphore(MAX_FETCHES)

    /**
     * The file for one of the editor's pictures, fetched when the phone lacks it; null when it
     * cannot be had (offline, the server has no such picture, the disk is full). Never throws
     * (A312). Blocks: the WebView asks on a background thread.
     */
    fun fileFor(sha: String, ext: String): File? {
        if (!SHA256.matches(sha) || ext !in TYPES) return null
        File(dir, "$sha.$ext").takeIf { it.isFile }?.let { return it }
        File(cache, "$sha.$ext").takeIf { it.isFile }?.let { return it }
        // One fetch per picture: other requests for it wait for that one.
        val mine = CompletableDeferred<File?>()
        val running = inFlight.putIfAbsent("$sha.$ext", mine)
        return try {
            runBlocking {
                if (running != null) {
                    running.await()
                } else {
                    try {
                        fetching.withPermit { fetch(sha, ext) }.also { mine.complete(it) }
                    } finally {
                        mine.complete(null)
                        inFlight.remove("$sha.$ext", mine)
                    }
                }
            }
        } catch (error: Exception) {
            null
        }
    }

    private val inFlight = ConcurrentHashMap<String, CompletableDeferred<File?>>()

    private suspend fun fetch(sha: String, ext: String): File? = withContext(Dispatchers.IO) {
        // Another request for it may have fetched it while this one waited its turn.
        File(cache, "$sha.$ext").takeIf { it.isFile }?.let { return@withContext it }
        try {
            val bytes = api.attachment(sha)
            // Content-addressed: what came back must be what was asked for, and a picture.
            if (sha256(bytes) != sha || sniff(bytes) == null) return@withContext null
            File(cache, "$sha.$ext").also { write(it, bytes) }
        } catch (error: IOException) {
            null
        }
    }

    /**
     * Uploads the pictures waiting, oldest first, as the web client does (A31): a refusal for
     * good (the wrong type, too large, bytes that do not match) is not retried; anything else
     * waits a little longer each time. Stops at the first network failure (offline).
     */
    suspend fun uploadDue(limit: Int = 50): Int = uploading.withLock { uploadDueNow(limit) }

    /** One upload run at a time: a pass and a note's own exchange may both ask. */
    private val uploading = Mutex()

    private suspend fun uploadDueNow(limit: Int): Int {
        var uploaded = 0
        for (picture in dao.dueUploads(now(), limit)) {
            val file = File(dir, "${picture.sha256}.${picture.ext}")
            if (!file.isFile) {
                dao.attempted(picture.sha256, now(), failed = true)
                continue
            }
            // Bounded: a picture the server keeps turning away is not sent again for ever.
            if (picture.attempts >= MAX_ATTEMPTS) {
                dao.attempted(picture.sha256, now(), failed = true)
                continue
            }
            // A large file waits for Wi-Fi: not 50 MB over mobile data, perhaps again and again (review PS2).
            if (file.length() > LARGE_UPLOAD && metered()) continue
            try {
                val head = withContext(Dispatchers.IO) { headOf(file) }
                // A file that is not a picture or a PDF names its extension, as the web's uploads do;
                // the server takes the rest from the bytes.
                val ext = picture.ext.takeIf { sniff(head) == null && !isPdf(head) }
                // Streamed from the file, never read whole (review PS2).
                api.putAttachment(picture.sha256, file, picture.noteId, ext)
                dao.uploaded(picture.sha256)
                uploaded++
            } catch (error: ApiException) {
                if (error.unauthorized) throw error
                // Only a timeout or a busy server passes. The upload needs no note on the server, so a
                // 404 means this is not the API the phone thinks (A313): not worth 50 MB an hour.
                val forGood = error.status in 400..499 && error.status !in RETRIED
                dao.attempted(picture.sha256, now() + backoff(picture.attempts), failed = forGood)
            } catch (error: UploadInterrupted) {
                // Cut short once its bytes were going out (a slow uplink's timeout): an attempt, so a
                // file too large for the network is not sent again for ever (review PS2).
                dao.attempted(picture.sha256, now() + backoff(picture.attempts), failed = false)
                break
            } catch (error: IOException) {
                // Offline: not the server's answer, so not counted against the picture.
                dao.postpone(picture.sha256, now() + backoff(picture.attempts))
                break
            }
        }
        return uploaded
    }

    suspend fun waitingCount(): Int = dao.waitingCount()

    fun observeWaiting() = dao.observeWaiting()

    fun observeFailed() = dao.observeFailed()

    fun observeWaiting(noteId: String) = dao.observeWaiting(noteId)

    fun observeFailed(noteId: String) = dao.observeFailed(noteId)

    /** Retry (AC8, A428): every picture given up on starts its tries again; returns how many. */
    suspend fun retryFailed(): Int = dao.retryFailed()

    /** Tries a picture refused before again from the start: the person asked (A348). */
    suspend fun retry(sha256: String) = dao.retry(sha256)

    /** Whether the server has a picture added here: what a capture naming it waits for (A338). */
    enum class Upload { UPLOADED, WAITING, REFUSED }

    suspend fun upload(sha256: String): Upload {
        val picture = dao.get(sha256) ?: return Upload.REFUSED
        return when {
            picture.uploaded -> Upload.UPLOADED
            picture.failed -> Upload.REFUSED
            else -> Upload.WAITING
        }
    }

    /** The bytes notes' files and pictures take on this phone: kept to upload, and fetched to show (ED12). */
    fun bytesUsed(): Long = listOf(dir, cache).sumOf { folder -> folder.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L }

    /** Forgets every picture's file (the cache was cleared for another account). */
    fun clearFiles() {
        dir.deleteRecursively()
        cache.deleteRecursively()
    }

    /** A file's first bytes, which tell its type (core's `SNIFF_BYTES`). */
    private fun headOf(file: File): ByteArray = file.inputStream().use { input ->
        val head = ByteArray(SNIFF_BYTES)
        var size = 0
        while (size < head.size) {
            val read = input.read(head, size, head.size - size)
            if (read < 0) break
            size += read
        }
        head.copyOf(size)
    }

    private fun write(file: File, bytes: ByteArray) {
        if (file.isFile && file.length() == bytes.size.toLong()) return
        val parent = file.parentFile ?: throw IOException("No folder for ${file.name}")
        parent.mkdirs()
        // A name of its own: two writes of the same picture never share a partial file.
        val partial = File.createTempFile(file.name, ".part", parent)
        try {
            partial.writeBytes(bytes)
            if (!partial.renameTo(file) && !(file.isFile && file.length() == bytes.size.toLong())) {
                throw IOException("Could not store ${file.name}")
            }
        } finally {
            partial.delete()
        }
    }

    companion object {
        /** The server's limit (A10). */
        const val MAX_BYTES = 50 * 1024 * 1024

        /** Files over this upload on Wi-Fi only (review PS2): the git mirror's limit. */
        const val LARGE_UPLOAD = 10L * 1024 * 1024

        /** The picture types the server takes (core's `IMAGE_TYPES`), by extension. */
        val TYPES = mapOf(
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "avif" to "image/avif",
        )

        private val SHA256 = Regex("^[0-9a-f]{64}$")

        const val PDF_EXT = "pdf"
        const val PDF_TYPE = "application/pdf"
        const val GENERIC_TYPE = "application/octet-stream"

        /** A file name's extension, lower-cased, as core's `fileExtension` reads it. */
        private val EXTENSION = Regex("\\.([a-z0-9]{1,10})$")

        fun fileExtension(name: String): String? = EXTENSION.find(name.trim().lowercase())?.groupValues?.get(1)

        /** Whether the bytes start as a PDF does (core's `sniffFileType`). */
        fun isPdf(bytes: ByteArray): Boolean =
            bytes.size >= 5 && String(bytes, 0, 5, Charsets.ISO_8859_1) == "%PDF-"

        /**
         * The extension a file is stored with, as core's `filePath`: a picture's or a PDF's from
         * its bytes, any other file's from its name (or `bin`).
         */
        fun extensionFor(bytes: ByteArray, name: String): String =
            sniff(bytes) ?: if (isPdf(bytes)) PDF_EXT else fileExtension(name) ?: "bin"

        /** Whether fetched bytes are of the kind their path names: a picture, a PDF, or anything else. */
        fun matchesExtension(bytes: ByteArray, ext: String): Boolean = when {
            ext in TYPES -> sniff(bytes) == ext
            ext == PDF_EXT -> isPdf(bytes)
            else -> true
        }

        /** The type a stored file is served as (the server's rule): pictures and PDFs as themselves. */
        fun typeOf(ext: String): String = TYPES[ext] ?: if (ext == PDF_EXT) PDF_TYPE else GENERIC_TYPE

        /** Refusals worth trying again: a timeout, too many requests. */
        private val RETRIED = setOf(408, 429)

        /** Answers short of success before a picture is given up (A313): about half a day of tries. */
        const val MAX_ATTEMPTS = 20

        /** Pictures fetched at once to show. */
        private const val MAX_FETCHES = 2

        fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

        private fun hex(digest: ByteArray): String = digest.joinToString("") { "%02x".format(it) }

        /** The bytes a type is told by (core's `SNIFF_BYTES`). */
        private const val SNIFF_BYTES = 64

        /**
         * The picture type the first bytes declare, as an extension, or null: the same magic
         * numbers as core's `sniffImageType` (packages/core/src/attachments.ts).
         */
        fun sniff(bytes: ByteArray): String? {
            fun at(offset: Int, vararg signature: Int) =
                bytes.size >= offset + signature.size && signature.indices.all { bytes[offset + it] == signature[it].toByte() }
            fun ascii(offset: Int, text: String) = at(offset, *text.map { it.code }.toIntArray())
            return when {
                at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "png"
                at(0, 0xff, 0xd8, 0xff) -> "jpg"
                ascii(0, "GIF87a") || ascii(0, "GIF89a") -> "gif"
                ascii(0, "RIFF") && ascii(8, "WEBP") -> "webp"
                isAvif(bytes) -> "avif"
                else -> null
            }
        }

        private fun isAvif(bytes: ByteArray): Boolean {
            if (bytes.size < 12 || String(bytes, 4, 4, Charsets.ISO_8859_1) != "ftyp") return false
            val brands = setOf("avif", "avis")
            fun brand(offset: Int) = String(bytes, offset, 4, Charsets.ISO_8859_1)
            if (brand(8) in brands) return true
            val boxSize = ((bytes[0].toInt() and 0xff) shl 24) or ((bytes[1].toInt() and 0xff) shl 16) or
                ((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)
            val end = minOf(boxSize.toLong() and 0xffffffffL, bytes.size.toLong()).toInt()
            var offset = 16
            while (offset + 4 <= end) {
                if (brand(offset) in brands) return true
                offset += 4
            }
            return false
        }

        /** 30 s, doubling, at most an hour. */
        private fun backoff(attempts: Int): Long = minOf(30_000L shl minOf(attempts, 7), 3_600_000L)
    }
}
