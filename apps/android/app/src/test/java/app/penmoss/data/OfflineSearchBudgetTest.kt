package app.penmoss.data

import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The offline search's wall-clock budgets (A1244, A1539). They run alone, never in the unit run:
 * `PENMOSS_BUDGETS=1`, one fork, after the rest of the job (`task android:budgets`). On a loaded
 * machine, or beside other forks, they missed their limits with nothing wrong in search.
 * OfflineSearchTest keeps every correctness check of the same searches; the limits are unchanged.
 */
@RunWith(AndroidJUnit4::class)
class OfflineSearchBudgetTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var search: OfflineSearch

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 5_000 })
        search = OfflineSearch(db)
    }

    @After
    fun close() = db.close()

    /** Review S-A (A610): 30 hits of about 30 KB each, marked, inside a keystroke's pause. */
    @Test
    fun marksThirtyLongHitsIn100Ms() = runTest {
        val filler = listOf("happiness", "relational", "conditioning", "Café", "我们今天", "ørsteds", "running", "generations")
        db.withTransaction {
            (1..30).forEach { i ->
                val id = "n%02d".format(i)
                store.saveChanges(ChangesPage(i.toLong(), notes = listOf(ChangedNote(id, i.toLong(), "Gardens $i", "", i.toLong()))))
                val body = buildString {
                    var k = 0
                    while (length < 30_000) append(filler[(i + k++) % filler.size]).append(if (k % 9 == 0) ".\n" else " ")
                    append("the target word at the end")
                }
                db.search().putText(NoteTextEntity.of(id, "Gardens $i", body, "", ""))
            }
        }
        search.search("garden target") // warm up
        val started = System.nanoTime()
        val hits = search.search("garden target")
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(30, hits.size)
        println("offline search, 30 hits of 30 KB: $elapsedMs ms")
        assertTrue("took $elapsedMs ms", elapsedMs < 100)
    }

    /** A large vault (as A101 timed the web's): 5,000 notes, a two-letter prefix, as typed. */
    @Test
    fun answersATwoLetterPrefixOverFiveThousandNotesIn300Ms() = runTest {
        val words = listOf("garden", "lemon", "basil", "train", "coast", "memory", "kitchen", "budget", "backup", "recipe", "gate", "gap")
        val ids = (1..5_000).map { "n%04d".format(it) }
        store.saveChanges(ChangesPage(1, notes = ids.mapIndexed { i, id -> ChangedNote(id, 1, "Note $i ${words[i % words.size]}", "", i.toLong()) }))
        db.withTransaction {
            ids.forEachIndexed { i, id ->
                val body = (0 until 60).joinToString(" ") { words[(i + it * 7) % words.size] + if (it % 5 == 0) "s" else "" }
                db.search().putText(NoteTextEntity.of(id, "Note $i ${words[i % words.size]}", body, "", ""))
            }
        }
        search.search("ga", prefixLast = true) // warm up
        val started = System.nanoTime()
        val hits = search.search("ga", prefixLast = true)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(OfflineSearch.DEFAULT_LIMIT, hits.size)
        println("offline search, 5,000 notes, \"ga\" as typed: $elapsedMs ms")
        assertTrue("took $elapsedMs ms", elapsedMs < 300)
    }
}
