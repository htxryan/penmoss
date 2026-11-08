package app.penmoss.sync

import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.api.SettingsChange
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.io.IOException

/**
 * Sends the settings changed on this phone (T40 P1, A410, A411) at the start of each pass, so
 * the tree the pass then reads already has them. The phone never writes the WorkspaceDoc: the
 * server runs the change with the web's own rules. A setting changed elsewhere since this
 * phone's base is refused (409) and dropped, unless the server holds a value this phone sent
 * without hearing back (its own change, landed), which is rebased and sent again. A change the
 * server will never take (400, 413, 403) is dropped and Settings says so. Offline, or a server
 * without the route (404), they wait.
 */
class SettingsSender(private val store: NoteStore, private val api: PenmossApi) {
    /** Sends what is due; returns how many settings the server took. */
    suspend fun sendDue(): Int {
        var taken = 0
        // Each round sends, drops or rebases at most the 20 settings the server takes at once
        // (custom themes first); the rest, and a rebased one (a choice made while its request was
        // out), go in the next. The bound is only a guard.
        repeat(MAX_ROUNDS) {
            val rows = store.settingsToSend()
            if (rows.isEmpty()) return taken
            val change = SettingsChange(JsonObject(rows.associate { it.key to json(it.value) }), JsonObject(rows.associate { it.key to store.baseToSend(it) }))
            try {
                val reply = api.putSettings(change)
                store.settingsSent(rows, reply.settings)
                taken += rows.size
            } catch (error: ApiException) {
                val named = error.keys.filter { key -> rows.any { it.key == key } }
                val all = rows.map { it.key }
                when {
                    error.unauthorized -> throw error
                    // Changed elsewhere since: those go (or are rebased, when it was this phone's own
                    // change); the rest are sent again in the next round. None named: malformed.
                    error.status == 409 && named.isNotEmpty() -> store.settingsOvertaken(named, error.settings)
                    // Not a value the server takes, too large, or refused for this phone: dropped,
                    // and Settings says which and why.
                    error.status == 400 || error.status == 409 || error.status == 413 -> {
                        store.settingsRefused(named.ifEmpty { all }, error.message ?: "Penmoss would not take it")
                        if (named.isEmpty()) return taken
                    }
                    error.status == 403 -> {
                        store.settingsRefused(all, error.message ?: "This phone may not change settings")
                        return taken
                    }
                    // A server without the route yet, or a busy one: the next pass tries again.
                    else -> return taken
                }
            } catch (offline: IOException) {
                return taken
            }
        }
        return taken
    }

    private fun json(text: String?): JsonElement = text?.let { PenmossJson.parseToJsonElement(it) } ?: JsonNull

    private companion object {
        /** More than every setting the phone changes, 20 a round, refused or rebased one by one. */
        const val MAX_ROUNDS = 40
    }
}
