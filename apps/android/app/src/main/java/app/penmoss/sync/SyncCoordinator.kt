package app.penmoss.sync

import android.database.sqlite.SQLiteCantOpenDatabaseException
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDiskIOException
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteFullException
import android.database.sqlite.SQLiteReadOnlyDatabaseException
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.engine.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import java.io.IOException

sealed interface SyncStatus {
    data object Idle : SyncStatus

    data object Syncing : SyncStatus

    data class Synced(val at: Long) : SyncStatus

    /**
     * The last pass could not reach the notebook's notes server, or ([serverError]) it answered
     * with a failure or a reply this version cannot read (T39); the cache is still readable.
     */
    data class Offline(val at: Long, val serverError: Boolean = false) : SyncStatus
}

/**
 * Why sync cannot go on by itself (T42 on Android, AC12, A651): the web's stop reasons this
 * phone can meet (A578, A582), each with its remedy in the notebook's Sync. Being offline or a
 * failure is not one: the next pass retries by itself.
 */
sealed interface SyncStop {
    /** Edits to these notes the server refused at the last exchange, by note, with its words (A582's `notes`). */
    data class Notes(val refused: Map<String, String>) : SyncStop

    /** The phone's own storage failed while syncing (full, or an error): nothing could be stored. */
    data class Storage(val detail: String) : SyncStop
}

/** What an open note needs from sync (the editor controller's view of [SyncCoordinator]). */
interface NoteSync {
    val exchanges: SharedFlow<ExchangeResult>

    /** Whether the app is in front: the open note checks for changes only then (A327). */
    val foreground: StateFlow<Boolean>

    suspend fun syncNote(noteId: String): ExchangeResult?

    /** Exchanges the note only if it changed on the server or has unsent edits. */
    suspend fun refreshNote(noteId: String): ExchangeResult?

    fun noteEdited(noteId: String)
}

/** How a background pass went (T35, A320), for the worker to decide what comes next. */
enum class PassOutcome {
    /** Everything due was exchanged. */
    SYNCED,

    /** The pass stopped at its batch limit with notes still due. */
    MORE,

    /** The app is in front: its own loop syncs, and was asked to now. */
    FOREGROUND,

    /** The notes server could not be reached, or answered with a failure: try again later. */
    FAILED,
}

/**
 * When sync runs (T32, T35): at start, on coming to the foreground, every
 * [FOREGROUND_INTERVAL_MS] while in front, and on request; in the background,
 * when WorkManager runs [backgroundPass] (A320). An edit syncs its note on its
 * own soon after typing pauses. One pass at a time, whoever asks for it: the
 * foreground loop and the background worker share one lock, so they never
 * exchange at once and never decide on the same stored state twice.
 */
class SyncCoordinator(
    private val scope: CoroutineScope,
    private val engine: () -> SyncEngine,
    /** A pass failed for a reason other than being offline: kept for feedback's Recent errors (A791). */
    private val onFailure: (Throwable) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    /**
     * Work each pass does besides the engine's (T33): [beforePass] runs first (dropping base
     * rows no edit needs, uploading pictures before the notes that name them), then the notes
     * are exchanged, then [afterPass] (filing notes made on the phone).
     */
    private val beforePass: suspend () -> Unit = {},
    private val afterPass: suspend () -> Unit = {},
    /** Runs before one note is exchanged on its own (an edit, the open note's poll): pictures first (A313). */
    private val beforeNote: suspend () -> Unit = {},
) : NoteSync {
    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    private val _exchanges = MutableSharedFlow<ExchangeResult>(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Every stored exchange, so the open note's editor gets what the server sent. */
    override val exchanges: SharedFlow<ExchangeResult> = _exchanges.asSharedFlow()

    private val requests = Channel<Unit>(Channel.CONFLATED)
    private val passMutex = Mutex()
    private val noteMutex = Mutex()
    private val editTimers = mutableMapOf<String, Job>()
    private var loop: Job? = null

    private val _foreground = MutableStateFlow(false)

    /** Whether the app is in front, where its own loop syncs. */
    override val foreground: StateFlow<Boolean> = _foreground.asStateFlow()

    /**
     * A 403 or a storage failure at the last pass or exchange; null once one succeeds, but a
     * storage stop only once a pass does: one note's exchange is too small to show the room a pass
     * needs, and clearing on it made "Sync stopped" flicker (#137, A659).
     */
    private val blocked = MutableStateFlow<SyncStop?>(null)

    /** Notes whose edits the server refused at their last exchange, with its words (A651). */
    private val refusedNotes = MutableStateFlow<Map<String, String>>(emptyMap())

    /** The refusals of the pass in flight: a complete pass replaces [refusedNotes] with them. */
    @Volatile
    private var passRefusals: MutableMap<String, String>? = null

    private val _stop = MutableStateFlow<SyncStop?>(null)

    /**
     * Why sync has stopped, or null while it can go on by itself (T42 on Android, AC12, A651):
     * storage first, then a sign-in refused, then notes refused.
     */
    val stop: StateFlow<SyncStop?> = _stop.asStateFlow()

    private fun publishStop() {
        _stop.value = blocked.value ?: refusedNotes.value.takeIf { it.isNotEmpty() }?.let(SyncStop::Notes)
    }

    fun publish(result: ExchangeResult) {
        val refused = result.refused
        if (refused != null) {
            passRefusals?.put(result.noteId, refused)
            refusedNotes.update { it + (result.noteId to refused) }
            publishStop()
        } else if (result.kind != ExchangeResult.Kind.RETRY && result.noteId in refusedNotes.value) {
            refusedNotes.update { it - result.noteId }
            publishStop()
        }
        _exchanges.tryEmit(result)
    }

    fun start() {
        if (loop != null) return
        loop = scope.launch {
            while (true) {
                // A request, or the interval while the app is in front.
                withTimeoutOrNull(FOREGROUND_INTERVAL_MS) { requests.receive() }
                if (_foreground.value) runPass()
            }
        }
    }

    fun setForeground(value: Boolean) {
        _foreground.value = value
        if (value) requestSync()
    }

    fun requestSync() {
        requests.trySend(Unit)
    }

    /** Passes begun and ended, whatever their outcome, for [syncNow]. */
    private val passesBegun = MutableStateFlow(0L)
    private val passesEnded = MutableStateFlow(0L)

    /**
     * Asks for a pass now and returns once a pass that began after the call has ended, whatever
     * its outcome (T39 review: Home's pull to refresh and Sync now). A pass already running ends
     * first and does not count; one that fails at once does. Returns if none begins within
     * [startWithinMs] of the one in flight ending (the app not in front).
     */
    suspend fun syncNow(startWithinMs: Long = SYNC_NOW_START_MS) {
        val begun = passesBegun.value
        requestSync()
        passesEnded.first { it >= begun }
        withTimeoutOrNull(startWithinMs) { passesBegun.first { it > begun } } ?: return
        passesEnded.first { it > begun }
    }

    /** An edit was stored: sync this note once typing pauses. */
    override fun noteEdited(noteId: String) {
        editTimers.remove(noteId)?.cancel()
        editTimers[noteId] = scope.launch {
            delay(EDIT_SYNC_DELAY_MS)
            syncNote(noteId)
        }
    }

    /** Exchanges one note now (opening it, or after an edit). Null when it could not. */
    override suspend fun syncNote(noteId: String): ExchangeResult? = noteMutex.withLock {
        guarded {
            beforeNote()
            engine().syncNote(noteId)
        }
    }

    override suspend fun refreshNote(noteId: String): ExchangeResult? = noteMutex.withLock {
        guarded {
            beforeNote()
            engine().refreshNote(noteId)
        }
    }

    /**
     * Waits for the sync work in flight to finish, and drops the edit syncs still waiting (a git
     * notebook being removed: nothing may store into its database once it is closed).
     */
    suspend fun quiesce() {
        editTimers.values.forEach { it.cancel() }
        editTimers.clear()
        passMutex.withLock { noteMutex.withLock { } }
        // What stopped this session's sync is not the next one's.
        blocked.value = null
        refusedNotes.value = emptyMap()
        publishStop()
    }

    private suspend fun runPass() {
        if (pass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) == PassOutcome.MORE) requestSync()
    }

    /**
     * A pass for WorkManager (T35, A320): the same pass the app runs in front, through the
     * same lock and the same work before and after it (pictures first, bases an open editor
     * holds kept, A309, A313), with as much prefetching as the network allows (A322). While
     * the app is in front its own loop syncs, so this only asks it to.
     */
    suspend fun backgroundPass(prefetch: Boolean, maxBatches: Int): PassOutcome {
        if (_foreground.value) {
            requestSync()
            return PassOutcome.FOREGROUND
        }
        return pass(prefetch, maxBatches)
    }

    private suspend fun pass(prefetch: Boolean, maxBatches: Int): PassOutcome = passMutex.withLock {
        passesBegun.update { it + 1 }
        try {
            onePass(prefetch, maxBatches)
        } finally {
            passesEnded.update { it + 1 }
        }
    }

    private suspend fun onePass(prefetch: Boolean, maxBatches: Int): PassOutcome {
        _status.value = SyncStatus.Syncing
        val refusals = HashMap<String, String>()
        passRefusals = refusals
        val report = try {
            guarded(isPass = true) {
                beforePass()
                engine().sync(prefetch, maxBatches).also { afterPass() }
            }
        } catch (stopped: Throwable) {
            // A pass WorkManager stopped part way (A329) says nothing new about the network.
            if (_status.value == SyncStatus.Syncing) _status.value = SyncStatus.Idle
            throw stopped
        } finally {
            passRefusals = null
        }
        if (report != null) _status.value = SyncStatus.Synced(now())
        // A complete pass sent every note with edits waiting: those it did not see refused are not (A582).
        if (report?.complete == true) {
            refusedNotes.value = HashMap(refusals)
            publishStop()
        }
        return when {
            report == null -> PassOutcome.FAILED
            !report.complete -> PassOutcome.MORE
            else -> PassOutcome.SYNCED
        }
    }

    /**
     * Why the last pass or exchange failed when the notes server answered (an error, or a reply
     * this version cannot read); null when it succeeded, or failed for being offline. Feedback's
     * Sync group names its kind (T49).
     */
    @Volatile
    var lastFailure: Throwable? = null
        private set

    private suspend fun <T> guarded(isPass: Boolean = false, block: suspend () -> T): T? = try {
        block().also {
            lastFailure = null
            if (isPass || blocked.value !is SyncStop.Storage) setBlocked(null)
        }
    } catch (error: ApiException) {
        lastFailure = error
        onFailure(error)
        _status.value = SyncStatus.Offline(now(), serverError = true)
        null
    } catch (error: SQLiteException) {
        // The phone's storage, not the notes server: retried every pass, said in Settings (A651).
        if (!isStorageFailure(error)) throw error
        lastFailure = error
        onFailure(error)
        setBlocked(SyncStop.Storage(error.message.orEmpty()))
        _status.value = SyncStatus.Offline(now(), serverError = true)
        null
    } catch (error: IOException) {
        lastFailure = null
        _status.value = SyncStatus.Offline(now())
        null
    } catch (error: SerializationException) {
        // A reply this version cannot read (a proxy page, a newer server): retried next pass.
        lastFailure = error
        onFailure(error)
        _status.value = SyncStatus.Offline(now(), serverError = true)
        null
    }

    private fun setBlocked(stop: SyncStop?) {
        if (blocked.value == stop) return
        blocked.value = stop
        publishStop()
    }

    companion object {
        /**
         * The storage failures a pass meets on a full or failing phone (A651); any other database
         * error is a fault in the app, and is thrown as before.
         */
        fun isStorageFailure(error: SQLiteException): Boolean =
            error is SQLiteFullException || error is SQLiteDiskIOException || error is SQLiteReadOnlyDatabaseException ||
                error is SQLiteCantOpenDatabaseException || error is SQLiteDatabaseCorruptException

        const val FOREGROUND_INTERVAL_MS = 60_000L
        const val EDIT_SYNC_DELAY_MS = 1_500L

        /** How long [syncNow] waits for its pass to begin. */
        const val SYNC_NOW_START_MS = 3_000L
    }
}
