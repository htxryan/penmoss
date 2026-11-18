package app.penmoss.git

import app.penmoss.data.SettingsStore
import app.penmoss.engine.settings.LocalSettings
import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.flow.combine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * The device's settings in the Journal notebook's device map, with no account (A1014; A827):
 * as on the Mac, every device setting (theme, fonts, display, symbols, the sidebar's layout,
 * `quickAccess.notes` …) is an entry `device/<key>` in the Journal notebook's WorkspaceDoc,
 * holding the same JSON value the Mac writes, so a change on the phone shows on the Mac and back.
 *
 * The device graph's Room keeps showing them where the account's settings were (its synced
 * settings), so every screen reads and changes them unchanged: [follow] lays the Journal's map
 * there whenever it changes (a pass after a pull brings the Mac's), and [change] writes to the
 * Journal notebook through its notes server, shown at once.
 *
 * The look and layout ([LocalSettings]: theme, fonts, Home's layout) stay on this phone (A1626):
 * kept in its own database, laid over the Journal's map, and never written to a notebook.
 */
class JournalDeviceSettings(
    /** The device graph's settings: where the screens read them. */
    private val device: SettingsStore,
    /** The Journal notebook's settings: its tree's device map. */
    private val journal: SettingsStore,
    /** Writes `{ key: value | null }` to the Journal notebook's device map; answers the map after. */
    private val write: suspend (JsonObject) -> JsonObject,
) {
    /** Changes being written: the map they will land in is not laid over them meanwhile. */
    private val writing = AtomicInteger(0)

    /**
     * Lays the Journal's device map over the device's settings whenever either changes (a sign-out
     * clearing them, a pull bringing another device's change). Runs until cancelled.
     */
    suspend fun follow() {
        combine(journal.observeDeviceMap(), device.observeLocalSettings(), device.observeSyncedSettings()) { map, local, shown ->
            Triple(map, local, shown)
        }.collect { (map, local, shown) ->
            // Not read from the notebook yet: nothing to show (the screens wait, as before a first sync).
            map ?: return@collect
            val wanted = shownOf(map, local)
            if (writing.get() == 0 && wanted != shown) device.useDeviceSettings(wanted)
        }
    }

    /**
     * Changes device settings (a null value removes one, so its default shows): shown at once, then
     * written to the Journal notebook's device map, which its sync commits and pushes. False when
     * the notebook would not take it; what it holds is shown again.
     */
    suspend fun change(changes: Map<String, JsonElement?>): Boolean {
        writing.incrementAndGet()
        try {
            device.showSettingChanges(changes)
            val (local, synced) = changes.entries.partition { LocalSettings.isLocal(it.key) }
            if (local.isNotEmpty()) device.keepLocally(local.associate { it.key to it.value })
            if (synced.isEmpty()) return true
            val answer = runCatching { write(JsonObject(synced.associate { (key, value) -> key to (value ?: JsonNull) })) }
            answer.exceptionOrNull()?.let { if (it is kotlinx.coroutines.CancellationException) throw it }
            answer.getOrNull()?.let { journal.putDeviceMap(it) }
            return answer.isSuccess
        } finally {
            writing.decrementAndGet()
            // What the notebook holds now, the change in it or not.
            journal.deviceMapNow()?.let { map ->
                val wanted = shownOf(map, device.localSettingsNow())
                if (wanted != device.syncedSettingsNow()) device.useDeviceSettings(wanted)
            }
        }
    }

    /** The Journal's [map] with this phone's own look and layout over it: a value replaces, a JsonNull removes. */
    private fun shownOf(map: JsonObject, local: JsonObject): JsonObject {
        // A note size picked on a Mac is for its screen: the phone shows its own, else its default (A1628).
        val shown = map.toMutableMap().apply { remove(SettingKeys.NOTE_FONT_SIZE) }
        for ((key, value) in local) {
            if (!LocalSettings.isLocal(key)) continue
            if (value is JsonNull) shown.remove(key) else shown[key] = value
        }
        return JsonObject(shown)
    }
}

