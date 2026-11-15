package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.settings.SettingDefaults
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.engine.settings.Settings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Synced settings (T40 P1, A410, A411): what the last tree sent with the changes made here laid
 * over it, the queue that sends them, where quick capture goes (A336), and a git notebook's
 * device map (A1014).
 */
class SettingsStore(
    private val db: PenmossDatabase,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val settings = db.settings()
    private val pendingSettings = db.pendingSettings()

    /**
     * The tree's settings, where captures go and the device map, inside [RoomSyncStore.saveTree]'s
     * transaction.
     */
    internal suspend fun saveTreeSettings(tree: SyncTree) {
        // The settings the phone shows and changes (T40 P1, A410, A411). A change made here that
        // the tree shows overtaken (the setting is no longer what it was when changed here) was
        // beaten by a newer one made elsewhere: it is dropped and the tree's value stands.
        // A tree showing a value this phone sent and has no answer for is its own change landing:
        // the change is done, or what was chosen since is based on it (A411).
        tree.settings.let { sent ->
            settings.put(SettingEntity(SYNCED_SETTINGS, sent.toString()))
            for (row in pendingSettings.all()) {
                val now = sent[row.key] ?: JsonNull
                when {
                    now == jsonOf(row.base) -> Unit
                    now in sentOf(row) -> landed(row, now)
                    else -> pendingSettings.delete(row.key)
                }
            }
        }
        // Where captures go, as the web and Mac apps remember it (T34, A336), unless a capture
        // that changes it is still waiting to tell the server (A346) or a change made in Settings
        // here is (A411); and the time zone a capture made now is read in (A344).
        val destination = tree.capture?.destination ?: Settings(tree.settings).captureDestination
        if (destination != null && db.captures().rememberingCount() == 0 && pendingSettings.get(SettingKeys.CAPTURE) == null) {
            settings.put(SettingEntity(CAPTURE_DESTINATION, destination))
        }
        tree.capture?.timeZone?.let { settings.put(SettingEntity(CAPTURE_TIME_ZONE, it)) }
        // A git notebook's device map (A1014): the device's settings if this is the Journal.
        tree.device?.let { settings.put(SettingEntity(DEVICE_SETTINGS, it.toString())) }
    }

    // --- quick capture (A336) ---

    /** Where captures go unless the person picks the other: the last pass's word, or today's note. */
    suspend fun captureDestination(): String =
        settings.get(CAPTURE_DESTINATION)?.takeIf { it == CaptureRequest.INBOX } ?: CaptureRequest.DAILY

    /** The synced time zone the last pass brought, or null before one did (A344). */
    suspend fun captureTimeZone(): String? = settings.get(CAPTURE_TIME_ZONE)

    // --- synced settings (T40 P1, A410, A411) ---

    /**
     * The settings as the phone shows them: what the last `/sync/tree` sent, with the changes made
     * here and not sent yet laid over it. [SettingsState.known] is false until a tree from a server
     * with the settings channel has come; until then nothing can be changed here.
     */
    data class SettingsState(
        val settings: Settings = Settings(),
        val known: Boolean = false,
        val unsent: Set<String> = emptySet(),
        /** Changes the server refused for good and the phone dropped, until the person dismisses it. */
        val refused: SettingsRefusal? = null,
    )

    /** Settings changed here that the server would not take (400, 413 or 403), and its reason. */
    data class SettingsRefusal(val keys: List<String>, val message: String)

    fun observeSettings(): Flow<SettingsState> =
        combine(settings.observe(SYNCED_SETTINGS), pendingSettings.observeAll(), settings.observe(SETTINGS_REFUSED)) { synced, pending, refused ->
            settingsOf(synced, pending, refused)
        }

    suspend fun settingsNow(): SettingsState =
        db.withTransaction { settingsOf(settings.get(SYNCED_SETTINGS), pendingSettings.all(), settings.get(SETTINGS_REFUSED)) }

    // --- a git notebook's device map (A1014) ---

    /** A git notebook's device map as its last tree sent it; null before one has. */
    fun observeDeviceMap(): Flow<JsonObject?> = settings.observe(DEVICE_SETTINGS).map { it?.let(::objectOf) }

    suspend fun deviceMapNow(): JsonObject? = settings.get(DEVICE_SETTINGS)?.let(::objectOf)

    /** The device map as a change to it answered, before the next tree brings it. */
    suspend fun putDeviceMap(map: JsonObject) = settings.put(SettingEntity(DEVICE_SETTINGS, map.toString()))

    /** The synced settings as stored, to compare with what they should be. */
    fun observeSyncedSettings(): Flow<JsonObject?> = settings.observe(SYNCED_SETTINGS).map { it?.let(::objectOf) }

    suspend fun syncedSettingsNow(): JsonObject? = settings.get(SYNCED_SETTINGS)?.let(::objectOf)

    /**
     * The device's settings from the Journal notebook's device map, with no account (A1014): they
     * stand where the account's would, so every screen reads and changes them as before.
     */
    suspend fun useDeviceSettings(map: JsonObject) = settings.put(SettingEntity(SYNCED_SETTINGS, map.toString()))

    /** [changes] shown at once over the settings (a null removes one), while they are written. */
    suspend fun showSettingChanges(changes: Map<String, JsonElement?>) = db.withTransaction {
        val now = objectOf(settings.get(SYNCED_SETTINGS)).toMutableMap()
        for ((key, value) in changes) if (value == null || value is JsonNull) now.remove(key) else now[key] = value
        settings.put(SettingEntity(SYNCED_SETTINGS, JsonObject(now).toString()))
    }

    private fun settingsOf(synced: String?, pending: List<PendingSettingEntity>, refused: String?): SettingsState {
        var shown = Settings(objectOf(synced))
        for (row in pending) shown = shown.with(row.key, jsonOf(row.value))
        return SettingsState(shown, known = synced != null, unsent = pending.mapTo(HashSet()) { it.key }, refused = refusalOf(refused))
    }

    private fun refusalOf(json: String?): SettingsRefusal? {
        val stored = objectOf(json).takeIf { it.isNotEmpty() } ?: return null
        val keys = (stored["keys"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
        val message = (stored["message"] as? JsonPrimitive)?.content.orEmpty()
        return SettingsRefusal(keys, message)
    }

    /**
     * Changes a setting on this phone ([value] null: back to its default): it shows at once and is
     * sent with `PUT /api/settings` by the next pass, offline too (A411). One row per setting: a
     * second change replaces the first and keeps what the phone saw before the first, its base.
     * Changing it back to that removes the row, unless a value was sent for it without an answer
     * yet: the server may hold that one, so the row stays to put the base back (A411). False until
     * the server has sent any settings.
     */
    suspend fun changeSetting(key: String, value: JsonElement?): Boolean = db.withTransaction {
        val synced = settings.get(SYNCED_SETTINGS) ?: return@withTransaction false
        val wanted = value?.takeUnless { it is JsonNull }
        val row = pendingSettings.get(key)
        val base = (if (row != null) jsonOf(row.base) else objectOf(synced)[key])?.takeUnless { it is JsonNull }
        if (wanted == base && row?.sent == null) {
            if (row != null) pendingSettings.delete(key)
        } else {
            pendingSettings.put(PendingSettingEntity(key, wanted?.toString(), base?.toString(), now(), row?.sent))
        }
        // The capture sheet starts on the destination chosen here (A336), and captures still
        // waiting no longer change it when sent: the choice made here is the later one (A411).
        if (key == SettingKeys.CAPTURE) {
            settings.put(SettingEntity(CAPTURE_DESTINATION, (wanted as? JsonPrimitive)?.content ?: SettingDefaults.CAPTURE))
            db.captures().forgetDestination()
        }
        true
    }

    /**
     * The settings to send now, at most [limit] (the notes server takes 20 at once; the rest go in
     * the next request), each marked as sent with its value until the server answers: if the
     * answer is lost, a tree or a 409 that shows that value is known for this phone's own. Only a
     * notebook's own settings are queued (Daily notes' templates and time zone): the device's,
     * themes among them, are written to the Journal notebook at once (A1014).
     */
    suspend fun settingsToSend(limit: Int = SettingLimits.PER_REQUEST): List<PendingSettingEntity> = db.withTransaction {
        pendingSettings.all().take(limit).onEach { row ->
            val value = jsonOf(row.value)
            val sent = sentOf(row)
            if (value !in sent) pendingSettings.put(row.copy(sent = JsonArray(sent + value).toString()))
        }
    }

    /** The base to send for [row]: what the phone saw before its change. */
    fun baseToSend(row: PendingSettingEntity): JsonElement = jsonOf(row.base)

    private fun sentOf(row: PendingSettingEntity): List<JsonElement> =
        row.sent?.let { runCatching { PenmossJson.parseToJsonElement(it) as? JsonArray }.getOrNull() }.orEmpty()

    /**
     * The server holds [now], a value this phone sent for [row]: that change is done, and a newer
     * choice made since goes next, based on it.
     */
    private suspend fun landed(row: PendingSettingEntity, now: JsonElement) {
        if (jsonOf(row.value) == now) {
            pendingSettings.delete(row.key)
        } else {
            pendingSettings.put(row.copy(base = now.takeUnless { it is JsonNull }?.toString(), sent = null))
        }
    }

    /** The settings changed here and not sent yet, by key. */
    suspend fun pendingSettings(): List<PendingSettingEntity> = pendingSettings.all()

    @androidx.annotation.VisibleForTesting
    suspend fun pendingSettingsCount(): Int = pendingSettings.count()

    /**
     * `PUT /api/settings` took [sent]: [now] is the settings as the server has them. Each row sent is
     * done; one changed again meanwhile stays to send, now based on what was sent, which the server
     * holds (as a move filed while another was made, A359).
     */
    suspend fun settingsSent(sent: List<PendingSettingEntity>, now: JsonObject) = db.withTransaction {
        if (settings.get(SYNCED_SETTINGS) != null) settings.put(SettingEntity(SYNCED_SETTINGS, now.toString()))
        for (done in sent) {
            val row = pendingSettings.get(done.key) ?: continue
            when {
                row.value == done.value -> pendingSettings.delete(done.key)
                else -> pendingSettings.put(row.copy(base = done.value, sent = null))
            }
        }
    }

    /**
     * The server refused [keys] as changed since their base (409); [server] is what it holds. A
     * setting it shows at a value this phone sent without an answer is this phone's own change,
     * landed: it is done or rebased, and the rest are dropped, a newer choice made elsewhere
     * winning (A410, A411). Returns how many were rebased, to send again.
     */
    suspend fun settingsOvertaken(keys: Collection<String>, server: JsonObject?): Int = db.withTransaction {
        var rebased = 0
        for (key in keys) {
            val row = pendingSettings.get(key) ?: continue
            val now = server?.let { it[key] ?: JsonNull }
            if (now != null && now in sentOf(row)) {
                landed(row, now)
                if (pendingSettings.get(key) != null) rebased++
            } else {
                pendingSettings.delete(key)
            }
        }
        rebased
    }

    /**
     * The server will never take these changes (a 400, 413 or 403): they are dropped, and Settings
     * says which and why until the person dismisses it (A411).
     */
    suspend fun settingsRefused(keys: Collection<String>, message: String) = db.withTransaction {
        for (key in keys) pendingSettings.delete(key)
        val stored = JsonObject(mapOf("keys" to JsonArray(keys.map(::JsonPrimitive)), "message" to JsonPrimitive(message)))
        settings.put(SettingEntity(SETTINGS_REFUSED, stored.toString()))
    }

    suspend fun dismissSettingsRefusal() = db.withTransaction { settings.delete(SETTINGS_REFUSED) }

    /** Drops these changes without a word. */
    @androidx.annotation.VisibleForTesting
    suspend fun dropSettings(keys: Collection<String>) = db.withTransaction {
        for (key in keys) pendingSettings.delete(key)
    }

    private fun objectOf(json: String?): JsonObject =
        json?.let { runCatching { PenmossJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: JsonObject(emptyMap())

    private fun jsonOf(json: String?): JsonElement =
        json?.let { runCatching { PenmossJson.parseToJsonElement(it) }.getOrNull() } ?: JsonNull

    private companion object {
        const val CAPTURE_DESTINATION = "captureDestination"
        const val CAPTURE_TIME_ZONE = "captureTimeZone"
        const val SYNCED_SETTINGS = "syncedSettings"
        const val SETTINGS_REFUSED = "settingsRefused"

        /** A git notebook's device map from its tree (A1014). */
        const val DEVICE_SETTINGS = "deviceSettings"
    }
}
