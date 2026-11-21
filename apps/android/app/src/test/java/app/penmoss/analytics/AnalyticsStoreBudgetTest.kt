package app.penmoss.analytics

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's usage record at its largest (PEN-137, AC35; PEN-177 raised it): 2,000,000 events,
 * session detail among them (about 2% note opens of about 4 KB, the rest mostly typing bursts and
 * cursor moves). Counts by state come from the kept counts, the viewer's pages and the sender's
 * batch from the indexes, the "will be removed" count from one indexed COUNT, and pruning to
 * 5,000 goes 5,000 rows at a time. Budgets are ceilings with 2× slack (core's `store.perf`), each
 * query timed over several runs and held to its median, never its slowest run (A1638, A1651);
 * run alone with `PENMOSS_BUDGETS=1` (`task android:budgets`, A1244, A1539). AnalyticsStoreTest
 * keeps every correctness check.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsStoreBudgetTest {
    private val database = AnalyticsDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val store = AnalyticsStore(database)

    @After
    fun close() = database.close()

    /** [block]'s median time over [runs] runs, held to [budgetMs]; its last result. */
    private fun <T> timed(what: String, budgetMs: Long, runs: Int = 5, block: () -> T): T {
        var result: T? = null
        val times = (1..runs).map {
            val started = System.nanoTime()
            result = block()
            (System.nanoTime() - started) / 1_000_000
        }.sorted()
        val median = times[times.size / 2]
        println("analytics store, $what: median $median ms of $times (budget $budgetMs ms)")
        assertTrue("$what took a median $median ms ($times), over $budgetMs ms", median <= budgetMs)
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private val note = JsonPrimitive("0123456789abcdef")

    /** A note's shape of about 4 KB: 600 tokens. */
    private val open = JsonObject(
        mapOf(
            "note" to note,
            "how" to JsonPrimitive("open"),
            "titleChars" to JsonPrimitive(24),
            "shape" to JsonArray(List(600) { k -> JsonPrimitive(if (k % 10 == 0) "h2:${k % 60}" else "p:${100 + k}") }),
        ),
    )

    private fun typing(block: Int) = JsonObject(mapOf("note" to note, "block" to JsonPrimitive(block), "typed" to JsonPrimitive(14), "deleted" to JsonPrimitive(2)))

    private fun cursor(block: Int) = JsonObject(mapOf("note" to note, "block" to JsonPrimitive(block)))

    /** The [i]th event's kind, name and props: 2% note opens, then typing, cursor moves and clicks. */
    private fun mix(i: Int): Triple<String, String, JsonObject> = when (val slot = i % 50) {
        0 -> Triple("note", "open", open)
        in 1..30 -> Triple("note", "typing", typing(slot))
        in 31..44 -> Triple("note", "cursor", cursor(slot))
        in 45..46 -> Triple("input", "search", JsonObject(mapOf("field" to JsonPrimitive("query"), "chars" to JsonPrimitive(slot))))
        else -> Triple("click", "privacy.view-data", JsonObject(emptyMap()))
    }

    @Test
    fun staysFastAt2000000Events() = runBlocking {
        val total = 2_000_000
        val now = 1_763_000_000_000L
        val session = "0123456789abcdef"
        val states = listOf(EventState.SENT, EventState.LOCAL, EventState.WAITING)
        // A week's worth, one event every 302 ms, in chunks of 10,000.
        val step = 7 * AnalyticsStore.DAY / total
        for (chunk in (0 until total).chunked(10_000)) {
            // One insert is one transaction.
            store.insert(
                chunk.map { i ->
                    val (kind, name, props) = mix(i)
                    AnalyticsEvent(session, i.toLong(), now - (total - i) * step, "android", "person", "0.4.2", "stable", "android", "17", "compact", kind, name, props) to states[i % 3]
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
        // Pruning runs once (it deletes): the whole of it, 5,000 rows a round, under its ceiling.
        val started = System.nanoTime()
        val removed = runBlocking { store.prune(Limits.DEFAULTS.with(Limits.EVENTS_MAX, 5_000), now) }
        val ms = (System.nanoTime() - started) / 1_000_000
        println("analytics store, pruning 2,000,000 to 5,000: $ms ms (budget 60000 ms)")
        assertTrue("pruning took $ms ms", ms <= 60_000)
        assertEquals(total - 5_000L, removed)
        assertEquals(5_000L, store.size())
    }
}
