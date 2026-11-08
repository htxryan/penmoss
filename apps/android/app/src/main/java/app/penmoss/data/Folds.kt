package app.penmoss.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Whether each toggle in a note is open on this phone (T40 P8, ED8, A485): one row per note,
 * its toggles by `calloutKey` as JSON. Device-local, never synced (ADR 0002: a fold writes
 * nothing to the note), and cleared with the rest of the cache on sign-out.
 */
@Entity(tableName = "folds")
data class FoldsEntity(
    @PrimaryKey val noteId: String,
    /** `{"note|Details|0": true}`: as the page sends them. */
    val folds: String,
)

@Dao
interface FoldsDao {
    @Query("SELECT folds FROM folds WHERE noteId = :noteId")
    suspend fun get(noteId: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(folds: FoldsEntity)

    @Query("DELETE FROM folds WHERE noteId = :noteId")
    suspend fun delete(noteId: String)
}

/** The editor's view of [FoldsDao]: a note's toggles, read before it opens and kept as they change. */
class FoldStore(private val dao: FoldsDao) {
    /** The note's toggles, or none; a row that cannot be read counts as none. */
    suspend fun folds(noteId: String): Map<String, Boolean> = withContext(Dispatchers.IO) {
        val raw = dao.get(noteId) ?: return@withContext emptyMap()
        val parsed = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return@withContext emptyMap()
        buildMap {
            for ((key, value) in parsed) {
                val open = (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: continue
                put(key, open)
            }
        }
    }

    /** Keeps the note's toggles as the page last sent them (all of them; the page caps them). */
    suspend fun save(noteId: String, folds: Map<String, Boolean>) = withContext(Dispatchers.IO) {
        if (folds.isEmpty()) {
            dao.delete(noteId)
        } else {
            dao.put(FoldsEntity(noteId, JsonObject(folds.mapValues { JsonPrimitive(it.value) }).toString()))
        }
    }
}
