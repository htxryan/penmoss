package app.penmoss.updates

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** The public releases: an Alpha build's notes are on `alpha`, a stable one's on the latest. */
const val RELEASES_URL = "https://github.com/htxryan/penmoss/releases"

/** Where [version]'s notes are: beside the downloads of the channel it came from. */
fun notesUrlFor(version: String): String =
    if (alphaBuildOf(version) != null) "$RELEASES_URL/download/alpha/release-notes.json"
    else "$RELEASES_URL/latest/download/release-notes.json"

/** The largest file read: the record grows by a few notes a build, so this is years of them. */
private const val MAX_BYTES = 4 * 1024 * 1024
const val NOTES_EVERY_MS = 60 * 60 * 1000L

/**
 * Release notes on the phone (PEN-109): fetched from GitHub when What's New opens and after the
 * version changes, at most once an hour, and kept in app storage so they read offline. A file
 * that doesn't read keeps the cache. Also remembers the last version the person was told about,
 * for the snackbar after an update.
 */
class ReleaseNotesStore(
    private val dir: File,
    private val prefs: Prefs,
    private val fetch: suspend (String) -> String? = ::httpGet,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** What the store keeps outside the cache file: when it last fetched, and the last version seen. */
    interface Prefs {
        fun long(key: String): Long?
        fun string(key: String): String?
        fun put(key: String, value: Long)
        fun put(key: String, value: String)
    }

    private val file = File(dir, "release-notes.json")
    private val state = MutableStateFlow<NotesFile?>(null)
    private var loaded = false
    private val lock = Mutex()

    /** The cached file, kept current; null until there is one. */
    val notes: StateFlow<NotesFile?> = state.asStateFlow()

    /** Reads the cache once. */
    suspend fun load(): NotesFile? = lock.withLock { loadLocked() }

    private suspend fun loadLocked(): NotesFile? {
        if (!loaded) {
            loaded = true
            state.value = withContext(Dispatchers.IO) { runCatching { parseNotes(file.readText()) }.getOrNull() }
        }
        return state.value
    }

    /** Fetches [version]'s file unless it was fetched in the last hour. Never throws. */
    suspend fun refresh(version: String) = lock.withLock {
        loadLocked()
        val url = notesUrlFor(version)
        val key = "notesFetchedAt:$url"
        val last = prefs.long(key)
        if (last != null && now() - last < NOTES_EVERY_MS) return@withLock
        prefs.put(key, now())
        val text = runCatching { fetch(url) }.getOrNull() ?: return@withLock
        if (text.length > MAX_BYTES) return@withLock
        val parsed = parseNotes(text) ?: return@withLock
        if (parsed == state.value) return@withLock
        withContext(Dispatchers.IO) {
            dir.mkdirs()
            val next = File(dir, "release-notes.json.tmp")
            next.writeText(text)
            next.renameTo(file)
        }
        state.value = parsed
    }

    /**
     * The version the phone ran before [version], when it changed and the snackbar hasn't been
     * answered; null otherwise. A first launch (no record) records [version] silently.
     */
    fun updatedFrom(version: String): String? {
        val seen = prefs.string(LAST_SEEN)
        if (seen == null) {
            prefs.put(LAST_SEEN, version)
            return null
        }
        return seen.takeIf { it != version }
    }

    /** The snackbar after an update was answered: [version] is seen, so it doesn't come back. */
    fun acknowledge(version: String) = prefs.put(LAST_SEEN, version)

    companion object {
        const val LAST_SEEN = "lastSeenVersion"

        @Volatile private var shared: ReleaseNotesStore? = null

        /** The app's one store, in its files directory and its own preferences. */
        fun get(context: Context): ReleaseNotesStore = shared ?: synchronized(this) {
            shared ?: run {
                val app = context.applicationContext
                val sp = app.getSharedPreferences("release-notes", Context.MODE_PRIVATE)
                ReleaseNotesStore(
                    File(app.filesDir, "release-notes"),
                    object : Prefs {
                        override fun long(key: String) = if (sp.contains(key)) sp.getLong(key, 0) else null
                        override fun string(key: String) = sp.getString(key, null)
                        override fun put(key: String, value: Long) = sp.edit().putLong(key, value).apply()
                        override fun put(key: String, value: String) = sp.edit().putString(key, value).apply()
                    },
                ).also { shared = it }
            }
        }
    }
}

/** The body of a public GET, or null for anything but 200 (GitHub's redirects are followed). */
internal suspend fun httpGet(url: String): String? = withContext(Dispatchers.IO) {
    var target = URL(url)
    repeat(5) {
        val connection = target.openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("User-Agent", "Penmoss-Android")
            when (connection.responseCode) {
                200 -> return@withContext connection.inputStream.use { stream ->
                    val out = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        if (out.size() > MAX_BYTES) return@use null
                    }
                    out.toByteArray().decodeToString()
                }
                301, 302, 303, 307, 308 -> {
                    val next = connection.getHeaderField("Location") ?: return@withContext null
                    target = URL(target, next)
                    // Only to https: a redirect never downgrades the connection.
                    if (target.protocol != "https") return@withContext null
                }
                else -> return@withContext null
            }
        } finally {
            connection.disconnect()
        }
    }
    null
}
