package app.penmoss.analytics

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's usage record at its largest (PEN-137, AC35): 800,000 events. Counts by state come
 * from the kept counts, the viewer's pages and the sender's batch from the indexes, the "will be
 * removed" count from one indexed COUNT, and pruning to 5,000 goes 5,000 rows at a time. Budgets
 * are ceilings with 2× slack (core's `store.perf`), run alone with `PENMOSS_BUDGETS=1`
 * (`task android:budgets`, A1244, A1539); AnalyticsStoreTest keeps every correctness check.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsStoreBudgetTest {
    private val database = AnalyticsDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val store = AnalyticsStore(database)

    @After
    fun close() = database.close()

    private fun <T> timed(what: String, budgetMs: Long, block: () -> T): T {
        val started = System.nanoTime()
        val result = block()
        val ms = (System.nanoTime() - started) / 1_000_000
        println("analytics store, $what: $ms ms (budget $budgetMs ms)")
        assertTrue("$what took $ms ms, over $budgetMs ms", ms <= budgetMs)
        return result
    }

    @Test
    fun staysFastAt800000Events() = runBlocking {
        val total = 800_000
        val now = 1_763_000_000_000L
        val session = "0123456789abcdef"
        val states = listOf(EventState.SENT, EventState.LOCAL, EventState.WAITING)
        // A week's worth, one event every 756 ms, in chunks of 10,000.
        val step = 7 * AnalyticsStore.DAY / total
        for (chunk in (0 until total).chunked(10_000)) {
            // One insert is one transaction.
            store.insert(
                chunk.map { i ->
                    AnalyticsEvent(session, i.toLong(), now - (total - i) * step, "android", "person", "0.4.2", "stable", "android", "17", "compact", "click", "privacy.view-data") to states[i % 3]
                },
            )
        }
        assertEquals(total.toLong(), store.size())

        timed("counts by state", 20) { runBlocking { store.counts() } }
        val first = timed("viewer's first page", 400) { runBlocking { store.page(null, null, 100) } }
        val last = first.last()
        timed("viewer's next page", 200) { runBlocking { store.page(null, AnalyticsStore.Cursor(last.at, last.id), 100) } }
        timed("a state's first page", 400) { runBlocking { store.page(EventState.LOCAL, null, 100) } }
        timed("the next batch", 40) { runBlocking { store.nextBatch(200) } }
        val lower = Limits.DEFAULTS.with(Limits.EVENTS_DAYS, 3)
        val outside = timed("will be removed", 200) { runBlocking { store.outside(lower, now) } }
        assertTrue(outside > 0)
        val removed = timed("pruning 800,000 to 5,000", 60_000) { runBlocking { store.prune(Limits.DEFAULTS, now) } }
        assertEquals(total - 5_000L, removed)
        assertEquals(5_000L, store.size())
    }
}
