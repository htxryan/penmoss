package app.penmoss.git

import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * A notebook's settings as Between Notebooks copies them (A1137, A1550; PEN-148): its device map
 * ([device]: the theme, Home, symbols, shortcuts and the rest, `device/<key>` in its WorkspaceDoc,
 * A1014) and its own ([own]: the time zone and the templates, A827). Together they are the Mac's
 * `mergedSettings`, which its Copy Settings… copies.
 */
data class NotebookSettings(val device: JsonObject, val own: JsonObject)

/**
 * Copy Settings… and Keep Settings in Step on the phone (A1137; PEN-148), as the Mac's
 * `copySettings`: every setting of one notebook that another lacks or holds otherwise is written
 * into it, and every one it holds that the first lacks is removed, so it reads the same. Quick
 * Access is never copied (its pins are each notebook's own notes), nor the badge (it names the
 * notebook it belongs to, A1504).
 */
object SettingsCopy {
    /** Not copied: Quick Access's pins and the badge, each notebook's own. */
    fun notCopied(key: String): Boolean = key == SettingKeys.QUICK_ACCESS || key.startsWith("badge.")

    /** The notebook's own keys (core's `isNotebookSetting`): its time zone, templates and badge. */
    fun isOwn(key: String): Boolean = key == SettingKeys.TIME_ZONE || key.startsWith("template.") || key.startsWith("badge.")

    /** What writing one notebook's settings into another changes: a null removes a setting. */
    data class Changes(val device: Map<String, JsonElement?>, val own: Map<String, JsonElement?>) {
        val size: Int get() = device.size + own.size
        val isEmpty: Boolean get() = size == 0
    }

    /** What makes [to]'s settings [from]'s, leaving what is not copied as it is. */
    fun changes(from: NotebookSettings, to: NotebookSettings): Changes =
        Changes(diff(from.device, to.device) { !isOwn(it) }, diff(from.own, to.own, ::isOwn))

    private fun diff(from: JsonObject, to: JsonObject, belongs: (String) -> Boolean): Map<String, JsonElement?> {
        val source = from.filter { (key, value) -> value !is JsonNull && belongs(key) && !notCopied(key) }
        val target = to.filter { (key, value) -> value !is JsonNull && belongs(key) && !notCopied(key) }
        val changes = linkedMapOf<String, JsonElement?>()
        for ((key, value) in source) if (target[key] != value) changes[key] = value
        for (key in target.keys) if (key !in source) changes[key] = null
        return changes
    }

    /**
     * Keep Settings in Step (A1137; PEN-148), this phone's choice: while [on], the primary
     * notebook's settings ([primary], null while not read yet) are copied to each of the [others]
     * a moment ([delayMs]) after each change, and once when the choice is turned on or a notebook
     * is added. One way only: a change made in another notebook stays there until the primary's
     * next change. A copy that fails is left for the next one. Runs until cancelled.
     */
    @OptIn(FlowPreview::class)
    suspend fun keepInStep(
        on: Flow<Boolean>,
        primary: Flow<NotebookSettings?>,
        others: Flow<List<String>>,
        delayMs: Long = IN_STEP_DELAY_MS,
        onFailure: (Throwable) -> Unit = {},
        copy: suspend (from: NotebookSettings, to: String) -> Unit,
    ) {
        on.distinctUntilChanged().collectLatest { enabled ->
            if (!enabled) return@collectLatest
            combine(primary.filterNotNull(), others) { settings, ids -> settings to ids }
                .debounce(delayMs)
                .distinctUntilChanged()
                .collectLatest { (settings, ids) ->
                    for (id in ids) {
                        try {
                            copy(settings, id)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            onFailure(error)
                        }
                    }
                }
        }
    }

    /** How long after a change of the primary's settings it goes to the others (the Mac's 300 ms). */
    const val IN_STEP_DELAY_MS = 300L
}

/** What Copy Settings… says once it has copied (the Mac's words): [changed] is how many settings changed. */
fun copiedWords(from: String, to: String?, changed: Int): String = when {
    changed == 0 -> "${to ?: "The other notebooks"} already had these settings."
    else -> "Copied $from’s settings to ${to ?: "the other notebooks"}."
}
