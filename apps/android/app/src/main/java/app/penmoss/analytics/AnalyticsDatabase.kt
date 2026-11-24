package app.penmoss.analytics

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

/** One event as it is recorded and sent (core's `AnalyticsEvent`). */
data class AnalyticsEvent(
    val session: String,
    val seq: Long,
    val at: Long,
    val client: String,
    val actor: String,
    val version: String,
    val channel: String,
    val os: String,
    val osVersion: String,
    val sizeClass: String?,
    val kind: String,
    val name: String,
    val props: JsonObject = JsonObject(emptyMap()),
) {
    /** The event as a batch carries it, in core's field order. */
    fun wire(): JsonObject = buildJsonObject {
        put("session", jsonOf(session))
        put("seq", jsonOf(seq))
        put("at", jsonOf(at))
        put("client", jsonOf(client))
        put("actor", jsonOf(actor))
        put("version", jsonOf(version))
        put("channel", jsonOf(channel))
        put("os", jsonOf(os))
        put("osVersion", jsonOf(osVersion))
        if (sizeClass != null) put("sizeClass", jsonOf(sizeClass))
        put("kind", jsonOf(kind))
        put("name", jsonOf(name))
        put("props", props)
    }

    private fun jsonOf(value: String): JsonElement = kotlinx.serialization.json.JsonPrimitive(value)

    private fun jsonOf(value: Long): JsonElement = kotlinx.serialization.json.JsonPrimitive(value)
}

/**
 * The local usage record (PEN-137, N10's twin on Android): one row per event, the upload queue and
 * what the viewer pages through. The same columns and indexes as the Mac's `events.db`: every query
 * the app runs is served by an index, counts by state are kept by triggers in [StateCountEntity],
 * the viewer pages by keyset on (at, id), and pruning deletes 5,000 rows at a time.
 */
@Entity(
    tableName = "events",
    indices = [
        Index(value = ["session", "seq"], unique = true, name = "events_key"),
        Index(value = ["at", "id"], name = "events_at"),
        Index(value = ["state", "at", "id"], name = "events_state_at"),
        Index(value = ["client", "at", "id"], name = "events_client_at"),
    ],
)
data class EventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val at: Long,
    val session: String,
    val seq: Long,
    val client: String,
    val actor: String,
    val version: String,
    val channel: String,
    val os: String,
    @ColumnInfo(name = "os_version") val osVersion: String,
    @ColumnInfo(name = "size_class") val sizeClass: String?,
    val kind: String,
    val name: String,
    /** The props as JSON. */
    val props: String,
    /** An [EventState] code. */
    val state: Int,
    @ColumnInfo(name = "sent_at") val sentAt: Long? = null,
) {
    val eventState: EventState get() = EventState.of(state)

    fun event(): AnalyticsEvent = AnalyticsEvent(
        session, seq, at, client, actor, version, channel, os, osVersion, sizeClass, kind, name,
        runCatching { kotlinx.serialization.json.Json.parseToJsonElement(props) as JsonObject }.getOrDefault(JsonObject(emptyMap())),
    )

    companion object {
        fun of(event: AnalyticsEvent, state: EventState) = EventEntity(
            at = event.at,
            session = event.session,
            seq = event.seq,
            client = event.client,
            actor = event.actor,
            version = event.version,
            channel = event.channel,
            os = event.os,
            osVersion = event.osVersion,
            sizeClass = event.sizeClass,
            kind = event.kind,
            name = event.name,
            props = event.props.toString(),
            state = state.code,
        )
    }
}

/** How many events are in each state, kept by triggers so a count never scans the table. */
@Entity(tableName = "state_counts")
data class StateCountEntity(@PrimaryKey val state: Int, val n: Long)

/** The last batch sent, for Copy as JSON, and the sender's backoff. */
@Entity(tableName = "meta")
data class MetaEntity(@PrimaryKey val key: String, val value: String?)

@Dao
interface EventDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(rows: List<EventEntity>): List<Long>

    @Query("UPDATE events SET state = :to WHERE state IN (:from)")
    suspend fun move(from: List<Int>, to: Int): Int

    @Query("SELECT * FROM events WHERE state = :state ORDER BY at, id LIMIT :limit")
    suspend fun oldest(state: Int, limit: Int): List<EventEntity>

    @Query("UPDATE events SET state = :to, sent_at = :at WHERE id IN (:ids) AND state = :from")
    suspend fun mark(ids: List<Long>, from: Int, to: Int, at: Long?): Int

    @Query("SELECT state, n FROM state_counts")
    suspend fun counts(): List<StateCountEntity>

    @Query("SELECT state, n FROM state_counts")
    fun observeCounts(): Flow<List<StateCountEntity>>

    /** A page of the record, newest first, by keyset (all states). */
    @Query("SELECT * FROM events WHERE (at < :at OR (at = :at AND id < :id)) ORDER BY at DESC, id DESC LIMIT :limit")
    suspend fun pageBefore(at: Long, id: Long, limit: Int): List<EventEntity>

    /** A page of one state, newest first, by keyset. */
    @Query("SELECT * FROM events WHERE state = :state AND (at < :at OR (at = :at AND id < :id)) ORDER BY at DESC, id DESC LIMIT :limit")
    suspend fun pageBefore(state: Int, at: Long, id: Long, limit: Int): List<EventEntity>

    @Query("SELECT COUNT(*) FROM events WHERE at < :cutoff")
    suspend fun olderThan(cutoff: Long): Long

    @Query("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < :cutoff ORDER BY at, id LIMIT :batch)")
    suspend fun deleteOlder(cutoff: Long, batch: Int): Int

    @Query("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY at, id LIMIT :batch)")
    suspend fun deleteOldest(batch: Int): Int

    @Query("SELECT value FROM meta WHERE `key` = :key")
    suspend fun meta(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun setMeta(row: MetaEntity)

    @Transaction
    suspend fun markAll(sent: List<Long>, refused: List<Long>, at: Long) {
        for (chunk in sent.chunked(CHUNK)) mark(chunk, EventState.WAITING.code, EventState.SENT.code, at)
        for (chunk in refused.chunked(CHUNK)) mark(chunk, EventState.WAITING.code, EventState.REFUSED.code, null)
    }

    companion object {
        /** SQLite's bound-variable limit is far above this; a batch is at most 200. */
        const val CHUNK = 500
    }
}

/**
 * The phone's usage record, a database of its own (`analytics.db`), apart from the notebooks'
 * caches and the device settings: never synced, never in a notebook, and excluded from Auto
 * Backup and device transfer with every other file of the app (`data_extraction_rules.xml`).
 */
@Database(entities = [EventEntity::class, StateCountEntity::class, MetaEntity::class], version = 1, exportSchema = true)
abstract class AnalyticsDatabase : RoomDatabase() {
    abstract fun events(): EventDao

    companion object {
        const val NAME = "analytics.db"

        /** The counts' rows and the triggers that keep them, made with the tables. */
        internal val TRIGGERS = listOf(
            "INSERT OR IGNORE INTO state_counts (state, n) VALUES (0, 0), (1, 0), (2, 0), (3, 0), (4, 0)",
            "CREATE TRIGGER IF NOT EXISTS events_counted_insert AFTER INSERT ON events BEGIN " +
                "UPDATE state_counts SET n = n + 1 WHERE state = NEW.state; END",
            "CREATE TRIGGER IF NOT EXISTS events_counted_delete AFTER DELETE ON events BEGIN " +
                "UPDATE state_counts SET n = n - 1 WHERE state = OLD.state; END",
            "CREATE TRIGGER IF NOT EXISTS events_counted_update AFTER UPDATE OF state ON events " +
                "WHEN OLD.state <> NEW.state BEGIN " +
                "UPDATE state_counts SET n = n - 1 WHERE state = OLD.state; " +
                "UPDATE state_counts SET n = n + 1 WHERE state = NEW.state; END",
        )

        private val callback = object : Callback() {
            override fun onCreate(db: SupportSQLiteDatabase) {
                TRIGGERS.forEach(db::execSQL)
            }

            override fun onOpen(db: SupportSQLiteDatabase) {
                // A database made before its triggers (or restored without them) gets them now.
                TRIGGERS.forEach(db::execSQL)
            }
        }

        fun open(context: Context, name: String = NAME): AnalyticsDatabase =
            Room.databaseBuilder(context, AnalyticsDatabase::class.java, name)
                .addCallback(callback)
                .build()

        fun inMemory(context: Context): AnalyticsDatabase =
            Room.inMemoryDatabaseBuilder(context, AnalyticsDatabase::class.java)
                .addCallback(callback)
                .build()
    }
}
