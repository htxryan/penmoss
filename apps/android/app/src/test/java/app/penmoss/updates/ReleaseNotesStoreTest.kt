package app.penmoss.updates

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Release notes on the phone (PEN-109): fetched at most hourly, cached, and the version last seen. */
class ReleaseNotesStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val file = """{"schema":1,"notes":[{"build":1174,"pr":1,"kind":"new","platform":null,"text":"Notes in the app."}],"releases":[]}"""

    private class MemoryPrefs : ReleaseNotesStore.Prefs {
        val values = mutableMapOf<String, Any>()
        override fun long(key: String) = values[key] as? Long
        override fun string(key: String) = values[key] as? String
        override fun put(key: String, value: Long) { values[key] = value }
        override fun put(key: String, value: String) { values[key] = value }
    }

    @Test
    fun fetchesAtMostHourlyAndKeepsTheFile() = runBlocking {
        var clock = 1_000_000L
        val asked = mutableListOf<String>()
        val answers = ArrayDeque(listOf<String?>(file, "{\"schema\":1}", null))
        val dir = tmp.newFolder()
        val store = ReleaseNotesStore(dir, MemoryPrefs(), fetch = { asked += it; answers.removeFirstOrNull() }, now = { clock })
        store.refresh("0.2.1")
        store.refresh("0.2.1")
        assertEquals(listOf("$RELEASES_URL/latest/download/release-notes.json"), asked)
        assertEquals("Notes in the app.", store.notes.value?.notes?.single()?.text)
        assertEquals(file, File(dir, "release-notes.json").readText())
        // A bad answer, then none: the cache stays.
        clock += NOTES_EVERY_MS
        store.refresh("0.2.1")
        clock += NOTES_EVERY_MS
        store.refresh("0.2.1")
        assertEquals(3, asked.size)
        assertEquals(1, store.notes.value?.notes?.size)
        // A new store reads the cache, offline.
        val again = ReleaseNotesStore(dir, MemoryPrefs(), fetch = { null })
        assertEquals(1, again.load()?.notes?.size)
    }

    @Test
    fun aFreshInstallIsSilentAndAChangedVersionIsReportedUntilAnswered() {
        val prefs = MemoryPrefs()
        val store = ReleaseNotesStore(tmp.newFolder(), prefs, fetch = { null })
        assertNull(store.updatedFrom("0.2.0"))
        assertNull(store.updatedFrom("0.2.0"))
        assertEquals("0.2.0", store.updatedFrom("0.2.1"))
        assertEquals("0.2.0", store.updatedFrom("0.2.1"))
        store.acknowledge("0.2.1")
        assertNull(store.updatedFrom("0.2.1"))
    }
}
