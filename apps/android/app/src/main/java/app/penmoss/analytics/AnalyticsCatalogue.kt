package app.penmoss.analytics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The names an event may carry, by kind (PEN-137): core's `catalogue.ts`, shipped with the app as
 * `apps/android/contract/analytics-v1.json` (a resource of engine-bridge, as the shortcuts are).
 * An event whose name is not here, or whose props are not typed for its kind, is dropped before
 * it is stored (core's `validate.ts`), so the phone can never record free text.
 */
class AnalyticsCatalogue(
    private val names: Map<String, Set<String>>,
    /** The words each setting's value may be (core's SETTING_VALUES); any other word is refused. */
    private val settingWords: Map<String, Set<String>> = emptyMap(),
    /** The CLI's own flags (core's CLI_FLAGS): a cli event names only these. */
    private val cliFlags: Set<String> = emptySet(),
    /** The clients that may send a kind at all (core's KIND_CLIENTS): a scroll only from the apps. */
    private val kindClients: Map<String, Set<String>> = KIND_CLIENTS,
) {
    fun has(kind: String, name: String): Boolean = names[kind]?.contains(name) == true

    fun names(kind: String): Set<String> = names[kind].orEmpty()

    /** Whether [value] is one of the words setting [name] may be (core's `isSettingWord`). */
    fun isWord(name: String, value: String): Boolean = settingWords[name]?.contains(value) == true

    /** Why an event is not valid, or null when it is (core's `eventProblem`). */
    fun problem(event: AnalyticsEvent): String? {
        if (!AnalyticsFormat.SESSION.matches(event.session)) return "session"
        if (event.seq < 0) return "seq"
        if (event.at < 0) return "at"
        if (event.client !in AnalyticsFormat.CLIENTS) return "client"
        if (event.actor !in AnalyticsFormat.ACTORS) return "actor"
        if (!VERSION.matches(event.version)) return "version"
        if (event.channel !in AnalyticsFormat.CHANNELS) return "channel"
        if (event.os !in AnalyticsFormat.OSES) return "os"
        if (!OS_VERSION.matches(event.osVersion)) return "osVersion"
        if (event.sizeClass != null && event.sizeClass !in AnalyticsFormat.SIZE_CLASSES) return "sizeClass"
        if (event.kind !in AnalyticsFormat.KINDS) return "kind"
        if (kindClients[event.kind]?.contains(event.client) == false) return "client"
        if (!has(event.kind, event.name)) return "name"
        val checks = props(event.kind, event.name)
        for ((key, value) in event.props) {
            val check = checks[key] ?: return "prop $key"
            if (!check(value)) return "prop $key value"
        }
        return null
    }

    private fun props(kind: String, name: String): Map<String, (JsonElement) -> Boolean> {
        // A setting's value: a boolean, a whole number, a count bucket, or one of its own words.
        val settingValue: (JsonElement) -> Boolean = { value ->
            val primitive = value as? JsonPrimitive
            when {
                primitive == null -> false
                primitive.isString -> primitive.content in AnalyticsFormat.COUNT_BUCKETS || primitive.content in settingWords[name].orEmpty()
                primitive.booleanOrNull != null -> true
                else -> !primitive.content.contains('.') && primitive.longOrNull?.let { it in 0..MAX_SETTING_NUMBER } == true
            }
        }
        val flags: (JsonElement) -> Boolean = { value ->
            value is JsonArray && value.size <= MAX_FLAGS && value.all { flag -> flag.string()?.let { FLAG.matches(it) && it in cliFlags } == true }
        }
        val screen: (JsonElement) -> Boolean = { value -> value.string()?.let { has("screen", it) } == true }
        // Props tied to one name (core's NAME_PROP_SPECS, PEN-174): that name takes these and no
        // other, and no other name of the kind takes them.
        NAME_PROPS["$kind.$name"]?.let { return it }
        return when (kind) {
            "app" -> mapOf("notebooks" to COUNT, "notes" to COUNT, "agents" to BOOL, "theme" to oneOf(BUILTIN_THEMES + "custom"), "active" to TOOK)
            "command" -> mapOf(
                "source" to oneOf(listOf("key", "palette", "button", "menu", "tray", "hotkey", "editor", "other")),
                "keys" to { value -> value.string()?.let(KEYS::matches) == true },
                "custom" to BOOL,
                "ran" to BOOL,
            )
            "screen" -> mapOf("from" to screen)
            "dialog" -> mapOf("action" to oneOf(listOf("open", "done", "cancel")), "open" to TOOK)
            "click" -> mapOf("state" to oneOf(listOf("on", "off")))
            "menu" -> mapOf("source" to oneOf(listOf("menubar", "tray", "context")))
            "setting" -> mapOf("value" to settingValue, "changed" to { value -> (value as? JsonPrimitive)?.booleanOrNull == true && !value.isString })
            "firstrun" -> mapOf("result" to oneOf(listOf("done", "back", "failed")), "error" to oneOf(FIRSTRUN_ERRORS))
            "feedback" -> mapOf(
                "type" to oneOf(listOf("bug", "feature")),
                "priority" to { value -> (value as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull in 1..4 },
                "screenshots" to COUNT,
                "logs" to BOOL,
                "groupsLeftOut" to COUNT,
            )
            "sync" -> mapOf("result" to oneOf(listOf("ok", "conflict", "offline", "failed")), "took" to TOOK, "changed" to COUNT)
            "cli" -> mapOf("flags" to flags, "exit" to oneOf(CLI_EXITS), "took" to TOOK, "tty" to BOOL)
            "tool" -> mapOf("agentClient" to oneOf(AGENT_CLIENTS), "result" to oneOf(listOf("ok", "invalid", "notFound", "conflict", "failed")), "took" to TOOK)
            // PEN-175: the area is the event's name; how far down it is, in hundredths.
            "scroll" -> mapOf("position" to FRACTION)
            // PEN-177: an input's name is the dialog its field is in; each note and tree name has its own props.
            "input" -> mapOf("field" to oneOf(SessionDetail.INPUT_FIELDS), "chars" to CHARS)
            else -> emptyMap()
        }
    }

    companion object {
        private val VERSION = Regex("^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[a-z0-9.]{1,20})?$")
        private val OS_VERSION = Regex("^\\d{1,4}(?:\\.\\d{1,4})?$")

        /** A normalised key combination: modifiers, then one key name ("Mod+Alt+N", "Ctrl+/"). */
        val KEYS = Regex(
            "^(?:(?:Mod|Ctrl|Alt|Shift|Meta|Cmd|Option)\\+){0,4}(?:[A-Z0-9]|F\\d{1,2}|[\\[\\]\\\\;',./`=-]|Enter|Escape|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$",
        )
        private val FLAG = Regex("^[a-z][a-z0-9-]{0,31}$")

        val BUILTIN_THEMES = listOf("penmoss", "paper", "slate", "nord", "solarized", "gruvbox", "rose-pine", "high-contrast")
        val FIRSTRUN_ERRORS = listOf("offline", "auth", "notFound", "conflict", "gitMissing", "refused", "other")
        val CLI_EXITS = listOf("OK", "ERROR", "USAGE", "AUTH", "NOT_FOUND", "CONFLICT", "AMBIGUOUS", "REFUSED")
        val AGENT_CLIENTS = listOf(
            "claude-code", "claude-desktop", "codex", "cursor", "vscode", "windsurf", "zed", "gemini", "goose", "cline", "continue", "penmoss", "other",
        )

        private fun JsonElement.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun oneOf(values: List<String>): (JsonElement) -> Boolean = { value -> value.string() in values }

        private val BOOL: (JsonElement) -> Boolean = { value -> value is JsonPrimitive && !value.isString && value.booleanOrNull != null }
        private val COUNT = oneOf(AnalyticsFormat.COUNT_BUCKETS)
        private val TOOK = oneOf(AnalyticsFormat.DURATION_BUCKETS)

        /** A window's length (PEN-174): a whole number of dp, a multiple of 10, 0 to MAX_LENGTH. */
        private val LENGTH: (JsonElement) -> Boolean = { value ->
            val primitive = value as? JsonPrimitive
            primitive != null && !primitive.isString && primitive.booleanOrNull == null && !primitive.content.contains('.') &&
                !primitive.content.contains('e', ignoreCase = true) &&
                primitive.longOrNull?.let { it in 0..AnalyticsFormat.MAX_LENGTH.toLong() && it % 10 == 0L } == true
        }

        /**
         * A scrolled area's position (PEN-175): a number from 0 to 1 that is a whole number of
         * hundredths, never a string or a boolean (core's `fraction`).
         */
        private val FRACTION: (JsonElement) -> Boolean = { value ->
            val primitive = value as? JsonPrimitive
            val number = primitive?.takeUnless { it.isString || it.booleanOrNull != null }?.doubleOrNull
            number != null && number.isFinite() && number in 0.0..1.0 && abs(number * 100 - (number * 100).roundToLong()) < 1e-9
        }

        /** A whole number, never a string, a boolean or a fraction, from 0 to [max]. */
        private fun whole(max: Long): (JsonElement) -> Boolean = { value ->
            val primitive = value as? JsonPrimitive
            primitive != null && !primitive.isString && primitive.booleanOrNull == null && !primitive.content.contains('.') &&
                !primitive.content.contains('e', ignoreCase = true) && primitive.longOrNull?.let { it in 0..max } == true
        }

        /** A note's or folder's ref (PEN-177): 16 lower-case hex characters. */
        private val REF: (JsonElement) -> Boolean = { value -> value.string()?.let(SessionDetail.REF::matches) == true }

        /** A block's position, a count of blocks or a depth (PEN-177): 0 to MAX_INDEX. */
        private val INDEX = whole(SessionDetail.MAX_INDEX.toLong())

        /** A length in characters (PEN-177): 0 to MAX_CHARS, exact. */
        private val CHARS = whole(SessionDetail.MAX_CHARS.toLong())

        /** A note's shape (PEN-177): block tokens within both caps. */
        private val SHAPE: (JsonElement) -> Boolean = { value -> SessionDetail.isShape(value) }
        private val TRUE: (JsonElement) -> Boolean = { value -> value is JsonPrimitive && !value.isString && value.booleanOrNull == true }

        /** Core's KIND_CLIENTS: the clients that may send a kind; a kind not listed comes from any. */
        val KIND_CLIENTS: Map<String, Set<String>> = mapOf(
            "scroll" to setOf("mac", "android"),
            "note" to setOf("mac", "android"),
            "input" to setOf("mac", "android"),
            "tree" to setOf("mac", "android"),
        )

        val WINDOWS = listOf("main", "note", "capture")
        val SIDEBAR_STATES = listOf("shown", "rail", "hidden")
        val PANEL_STATES = listOf("open", "closed", "none")
        val THEME_MODES = listOf("light", "dark", "system")

        /** Core's NAME_PROP_SPECS: `app window` and `app layout` take only their own props. */
        private val NAME_PROPS: Map<String, Map<String, (JsonElement) -> Boolean>> = mapOf(
            "app.window" to mapOf(
                "window" to oneOf(WINDOWS),
                "width" to LENGTH,
                "height" to LENGTH,
                "fullScreen" to BOOL,
                "maximised" to BOOL,
            ),
            "app.layout" to mapOf(
                "window" to oneOf(listOf("main", "note")),
                "sidebar" to oneOf(SIDEBAR_STATES),
                "sidebarWidth" to LENGTH,
                "panel" to oneOf(PANEL_STATES),
                "fullWidth" to BOOL,
                "themeMode" to oneOf(THEME_MODES),
                "tabs" to COUNT,
            ),
            // PEN-177: session detail, by refs and block positions, never a word.
            "note.open" to mapOf(
                "note" to REF,
                "folder" to REF,
                "how" to oneOf(listOf("open", "switch", "resync")),
                "titleChars" to CHARS,
                "shape" to SHAPE,
                "more" to TRUE,
            ),
            "note.typing" to mapOf("note" to REF, "block" to INDEX, "title" to TRUE, "typed" to CHARS, "deleted" to CHARS, "remote" to TRUE),
            "note.blocks" to mapOf("note" to REF, "block" to INDEX, "removed" to INDEX, "inserted" to SHAPE, "remote" to TRUE),
            "note.cursor" to mapOf("note" to REF, "block" to INDEX, "title" to TRUE),
            "note.select" to mapOf("note" to REF, "block" to INDEX, "chars" to CHARS, "span" to INDEX),
            "tree.expand" to mapOf("folder" to REF, "depth" to INDEX, "source" to oneOf(listOf("click", "key", "reveal"))),
            "tree.collapse" to mapOf("folder" to REF, "depth" to INDEX, "source" to oneOf(listOf("click", "key", "reveal"))),
            "tree.open" to mapOf("note" to REF, "folder" to REF, "depth" to INDEX, "source" to oneOf(listOf("click", "key"))),
        )
        const val MAX_FLAGS = 16
        const val MAX_SETTING_NUMBER = 10_000_000L

        /** Reads the contract: its `catalogue` (kind → names), `settingValues`, `cliFlags` and `kindClients`. */
        fun parse(text: String): AnalyticsCatalogue {
            val root = Json.parseToJsonElement(text) as JsonObject
            val catalogue = root["catalogue"] as? JsonObject ?: error("analytics-v1.json has no catalogue")
            fun words(value: JsonElement?) = (value as? JsonArray)?.mapNotNull { it.string() }?.toSet().orEmpty()
            return AnalyticsCatalogue(
                catalogue.mapValues { (_, names) -> words(names) },
                (root["settingValues"] as? JsonObject)?.mapValues { (_, values) -> words(values) }.orEmpty(),
                words(root["cliFlags"]),
                (root["kindClients"] as? JsonObject)?.mapValues { (_, clients) -> words(clients) } ?: KIND_CLIENTS,
            )
        }

        /**
         * The catalogue the app ships; an empty one (every event dropped, nothing recorded) when the
         * build has none, so a broken build never records anything it should not.
         */
        val bundled: AnalyticsCatalogue by lazy {
            runCatching {
                AnalyticsCatalogue::class.java.getResourceAsStream("/analytics-v1.json")?.use { parse(it.readBytes().decodeToString()) }
            }.getOrNull() ?: AnalyticsCatalogue(emptyMap())
        }
    }
}
