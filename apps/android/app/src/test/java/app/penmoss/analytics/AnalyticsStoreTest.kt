package app.penmoss.analytics

import androidx.paging.PagingSource
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's usage record (PEN-137, AC10, AC17, AC35's correctness twin): events keep their
 * state, the counts follow every move, the viewer pages newest first by keyset, and pruning keeps
 * the record within its limits, a batch at a time.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsStoreTest {
    private val database = AnalyticsDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val store = AnalyticsStore(database)

    @After
    fun close() = database.close()

    private fun event(seq: Long, at: Long, name: String = "privacy.view-data", session: String = "0123456789abcdef") = AnalyticsEvent(
        session = session,
        seq = seq,
        at = at,
        client = "android",
        actor = "person",
        version = "0.4.2",
        channel = "stable",
        os = "android",
        osVersion = "17",
        sizeClass = "compact",
        kind = "click",
        name = name,
    )

    private suspend fun seed(count: Int, state: EventState, start: Long = 1_000, step: Long = 1, from: Long = 0): List<AnalyticsEvent> {
        val events = (0 until count).map { event(from + it, start + it * step) }
        store.insert(events.map { it to state })
        return events
    }

    @Test
    fun keepsEachEventOnceAndCountsItsState() = runBlocking {
        seed(3, EventState.PENDING)
        // The same session and seq again (a retried insert) adds nothing.
        assertEquals(0, store.insert(listOf(event(0, 1_000) to EventState.PENDING)))
        store.insert(listOf(event(10, 5_000) to EventState.LOCAL))
        assertEquals(3L, store.counts()[EventState.PENDING])
        assertEquals(1L, store.counts()[EventState.LOCAL])
        assertEquals(4L, store.size())
    }

    @Test
    fun theAnswerMovesOnlyWhatItShould() = runBlocking {
        seed(4, EventState.PENDING)
        seed(2, EventState.LOCAL, from = 100)
        assertEquals(4, store.applyAnswer(ConsentAnswer.YES))
        assertEquals(4L, store.counts()[EventState.WAITING])
        // A local event never changes, whatever comes later.
        assertEquals(2L, store.counts()[EventState.LOCAL])
        assertEquals(4, store.sharingOff())
        assertEquals(6L, store.counts()[EventState.LOCAL])
        assertEquals(0L, store.counts()[EventState.WAITING])

        seed(2, EventState.PENDING, from = 200)
        seed(2, EventState.WAITING, from = 300)
        assertEquals(4, store.unsentToLocal())
        assertEquals(10L, store.counts()[EventState.LOCAL])
    }

    @Test
    fun theQueueIsTheOldestWaitingAndOnlyWaitingEventsAreMarked() = runBlocking {
        seed(5, EventState.WAITING, start = 2_000, step = -1)
        seed(1, EventState.LOCAL, from = 50)
        val batch = store.nextBatch(3)
        assertEquals(listOf(1_996L, 1_997L, 1_998L), batch.map { it.at })
        store.mark(sent = listOf(batch[0].id, batch[1].id), refused = listOf(batch[2].id), at = 9_000)
        assertEquals(2L, store.counts()[EventState.SENT])
        assertEquals(1L, store.counts()[EventState.REFUSED])
        assertEquals(2L, store.counts()[EventState.WAITING])
        // Marking a local event does nothing: only waiting events can be sent.
        val local = store.page(EventState.LOCAL, null, 10).single()
        store.mark(sent = listOf(local.id), refused = emptyList(), at = 9_500)
        assertEquals(1L, store.counts()[EventState.LOCAL])
        assertEquals(9_000L, store.page(EventState.SENT, null, 10).first().sentAt)
    }

    @Test
    fun pagesNewestFirstByKeysetAndFilters() = runBlocking {
        // Two share a time: the id breaks the tie.
        seed(250, EventState.SENT)
        store.insert(listOf(event(900, 1_249) to EventState.LOCAL))
        val first = store.page(null, null, 100)
        assertEquals(100, first.size)
        assertEquals(1_249L, first[0].at)
        assertEquals(EventState.LOCAL, first[0].eventState)
        assertEquals(1_249L, first[1].at)
        assertTrue(first.zipWithNext().all { (a, b) -> a.at > b.at || (a.at == b.at && a.id > b.id) })
        val last = first.last()
        val second = store.page(null, AnalyticsStore.Cursor(last.at, last.id), 100)
        assertTrue(second.none { it.id in first.map { row -> row.id } })
        val third = store.page(null, AnalyticsStore.Cursor(second.last().at, second.last().id), 100)
        assertEquals(51, third.size)
        assertEquals(1, store.page(EventState.LOCAL, null, 100).size)
        assertEquals(100, store.page(EventState.SENT, null, 100).size)
    }

    @Test
    fun theViewersPagingSourceLoadsPagesUntilTheEnd() = runBlocking {
        seed(230, EventState.WAITING)
        val source = store.pagingSource(null)
        val first = source.load(PagingSource.LoadParams.Refresh(null, 100, false)) as PagingSource.LoadResult.Page
        assertEquals(100, first.data.size)
        assertNull(first.prevKey)
        val second = source.load(PagingSource.LoadParams.Append(first.nextKey!!, 100, false)) as PagingSource.LoadResult.Page
        val third = source.load(PagingSource.LoadParams.Append(second.nextKey!!, 100, false)) as PagingSource.LoadResult.Page
        assertEquals(30, third.data.size)
        assertNull(third.nextKey)
        assertEquals(230, (first.data + second.data + third.data).map { it.id }.toSet().size)
        val filtered = store.pagingSource(EventState.LOCAL).load(PagingSource.LoadParams.Refresh(null, 100, false)) as PagingSource.LoadResult.Page
        assertTrue(filtered.data.isEmpty())
    }

    @Test
    fun prunesByAgeThenByCapABatchAtATime() = runBlocking {
        val day = AnalyticsStore.DAY
        val now = 100 * day
        // 30 events ten days old, 40 from today.
        store.insert((0 until 30).map { event(it.toLong(), now - 10 * day + it) to EventState.SENT })
        store.insert((0 until 40).map { event(100L + it, now - 1_000 + it) to EventState.LOCAL })
        val limits = Limits.DEFAULTS.with(Limits.EVENTS_DAYS, 7).with(Limits.EVENTS_MAX, 500)
        assertEquals(30L, store.outside(limits, now))
        assertEquals(30L, store.prune(limits, now, batch = 7))
        assertEquals(40L, store.size())
        assertEquals(0L, store.counts()[EventState.SENT])
        // A lower cap keeps the newest.
        val capped = Limits.of(mapOf(Limits.EVENTS_MAX to 500)).let { Limits(it.values + (Limits.EVENTS_MAX to 25)) }
        assertEquals(15L, store.outside(capped, now))
        assertEquals(15L, store.prune(capped, now, batch = 4))
        assertEquals(25L, store.size())
        assertEquals(now - 1_000 + 15, store.page(null, null, 100).last().at)
        // Raising a limit brings nothing back.
        assertEquals(0L, store.prune(Limits.DEFAULTS, now))
        assertEquals(25L, store.size())
    }
}
