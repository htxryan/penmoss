package app.penmoss.analytics

import androidx.paging.PagingSource
import androidx.paging.PagingState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield

/**
 * The phone's usage record (PEN-137), as core's node `AnalyticsStore` is the Mac's: inserts,
 * the answer's moves between states, the sender's queue, the counts, the viewer's pages, and
 * pruning to the limits, 5,000 rows at a time. Everything runs on [Dispatchers.IO]: never on the
 * main thread.
 */
class AnalyticsStore(val database: AnalyticsDatabase) {
    private val dao = database.events()

    /** Inserts events in one transaction; one already there (same session and seq) is skipped. */
    suspend fun insert(events: List<Pair<AnalyticsEvent, EventState>>): Int = withContext(Dispatchers.IO) {
        if (events.isEmpty()) return@withContext 0
        dao.insert(events.map { (event, state) -> EventEntity.of(event, state) }).count { it != -1L }
    }

    /** The first answer: pending events become waiting (Yes) or local (No). */
    suspend fun applyAnswer(answer: ConsentAnswer): Int = io {
        dao.move(listOf(EventState.PENDING.code), if (answer == ConsentAnswer.YES) EventState.WAITING.code else EventState.LOCAL.code)
    }

    /** Sharing turned off: waiting events become local at once. */
    suspend fun sharingOff(): Int = io { dao.move(listOf(EventState.WAITING.code), EventState.LOCAL.code) }

    /** A new ID: unsent events become local, so none goes under the new one. */
    suspend fun unsentToLocal(): Int = io { dao.move(listOf(EventState.WAITING.code, EventState.PENDING.code), EventState.LOCAL.code) }

    /** The oldest waiting events, at most [limit]. */
    suspend fun nextBatch(limit: Int = AnalyticsFormat.MAX_BATCH_EVENTS): List<EventEntity> = io { dao.oldest(EventState.WAITING.code, limit) }

    /** What the endpoint did: these were taken, these refused. Only waiting events change. */
    suspend fun mark(sent: List<Long>, refused: List<Long>, at: Long) = io { dao.markAll(sent, refused, at) }

    /** How many events are in each state (from the kept counts). */
    suspend fun counts(): Map<EventState, Long> = io { countsOf(dao.counts()) }

    /** The counts as they change. */
    fun observeCounts(): Flow<Map<EventState, Long>> = dao.observeCounts().map(::countsOf)

    private fun countsOf(rows: List<StateCountEntity>): Map<EventState, Long> {
        val out = EventState.entries.associateWith { 0L }.toMutableMap()
        for (row in rows) out[EventState.of(row.state)] = maxOf(0L, row.n)
        return out
    }

    suspend fun size(): Long = counts().values.sum()

    /** One page of events, newest first, older than [before] (the first page when null). */
    suspend fun page(state: EventState?, before: Cursor?, limit: Int): List<EventEntity> = io {
        val at = before?.at ?: Long.MAX_VALUE
        val id = before?.id ?: Long.MAX_VALUE
        if (state == null) dao.pageBefore(at, id, limit) else dao.pageBefore(state.code, at, id, limit)
    }

    /** The viewer's pages (Paging 3), newest first, keyset on (at, id). */
    fun pagingSource(state: EventState?): PagingSource<Cursor, EventEntity> = KeysetSource(this, state)

    /** How many events the limits would remove now: older than the days, or beyond the cap. */
    suspend fun outside(limits: Limits, now: Long): Long = io {
        val old = dao.olderThan(now - limits.eventsDays * DAY)
        val kept = countsOf(dao.counts()).values.sum() - old
        old + maxOf(0L, kept - limits.eventsMax)
    }

    /**
     * Removes what falls outside [limits], [batch] rows at a time, yielding between batches; how
     * many went. Raising a limit later never brings anything back.
     */
    suspend fun prune(limits: Limits, now: Long, batch: Int = PRUNE_BATCH): Long = io {
        var removed = 0L
        val cutoff = now - limits.eventsDays * DAY
        while (true) {
            val changes = dao.deleteOlder(cutoff, batch)
            removed += changes
            if (changes < batch) break
            yield()
        }
        while (true) {
            val excess = countsOf(dao.counts()).values.sum() - limits.eventsMax
            if (excess <= 0) break
            removed += dao.deleteOldest(minOf(batch.toLong(), excess).toInt())
            yield()
        }
        removed
    }

    suspend fun meta(key: String): String? = io { dao.meta(key) }

    suspend fun setMeta(key: String, value: String?) = io { dao.setMeta(MetaEntity(key, value)) }

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    /** A place in the list, newest first. */
    data class Cursor(val at: Long, val id: Long)

    private class KeysetSource(private val store: AnalyticsStore, private val state: EventState?) : PagingSource<Cursor, EventEntity>() {
        override suspend fun load(params: LoadParams<Cursor>): LoadResult<Cursor, EventEntity> = try {
            val rows = store.page(state, params.key, params.loadSize)
            val last = rows.lastOrNull()
            LoadResult.Page(
                data = rows,
                prevKey = null,
                nextKey = if (rows.size < params.loadSize || last == null) null else Cursor(last.at, last.id),
            )
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            LoadResult.Error(error)
        }

        /** A refresh starts again from the newest: the list is a log, newest first. */
        override fun getRefreshKey(state: PagingState<Cursor, EventEntity>): Cursor? = null
    }

    companion object {
        const val DAY = 86_400_000L
        const val PRUNE_BATCH = 5_000

        /** The viewer's page (core's 100). */
        const val PAGE = 100

        const val LAST_BATCH = "lastBatch"
        const val LAST_BATCH_AT = "lastBatchAt"
        const val FAILURES = "sendFailures"
        const val NEXT_TRY = "nextTryAt"
    }
}
