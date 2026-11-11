package app.penmoss.git

import app.penmoss.data.NoteStore
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

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
 */
class JournalDeviceSettings(
    /** The device graph's store: where the screens read the settings. */
    private val device: NoteStore,
    /** The Journal notebook's store: its tree's device map. */
    private val journal: NoteStore,
    /** Writes `{ key: value | null }` to the Journal notebook's device map; answers the map after. */
    private val write: suspend (JsonObject) -> JsonObject,
) {
    /** Changes being written: the map they will land in is not laid over them meanwhile. */
    private var writing = 0

    /**
     * Guards [writing] and each lay of the map, so a lay that saw no change being written can't
     * land after one starts, putting back the map from before it.
     */
    private val laying = Mutex()

    /** Lays what the notebook holds now over the shown settings, unless a change is being written. */
    private suspend fun lay() = laying.withLock {
        // Not read from the notebook yet: nothing to show (the screens wait, as before a first sync).
        val map = journal.deviceMapNow() ?: return@withLock
        if (writing == 0 && map != device.syncedSettingsNow()) device.useDeviceSettings(map)
    }

    /**
     * Lays the Journal's device map over the device's settings whenever either changes (a sign-out
     * clearing them, a pull bringing another device's change). Runs until cancelled.
     */
    suspend fun follow() {
        // Each emission only says something changed: lay() reads the map as it is now, not as it
        // was when the emission was made, which a change may since have passed.
        combine(journal.observeDeviceMap(), device.observeSyncedSettings()) { map, shown -> map to shown }.collect { lay() }
    }

    /**
     * Changes device settings (a null value removes one, so its default shows): shown at once, then
     * written to the Journal notebook's device map, which its sync commits and pushes. False when
     * the notebook would not take it; what it holds is shown again.
     */
    suspend fun change(changes: Map<String, JsonElement?>): Boolean {
        laying.withLock { writing++ }
        try {
            device.showSettingChanges(changes)
            val answer = runCatching { write(JsonObject(changes.mapValues { (_, value) -> value ?: JsonNull })) }
            answer.exceptionOrNull()?.let { if (it is kotlinx.coroutines.CancellationException) throw it }
            answer.getOrNull()?.let { journal.putDeviceMap(it) }
            return answer.isSuccess
        } finally {
            // What the notebook holds now, the change in it or not (shown once no other change is being written).
            withContext(NonCancellable) {
                laying.withLock { writing-- }
                lay()
            }
        }
    }
}

