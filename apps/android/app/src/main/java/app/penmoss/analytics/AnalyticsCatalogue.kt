package app.penmoss.analytics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

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
) {
    fun has(kind: String, name: String): Boolean = names[kind]?.contains(name) == true

    fun names(kind: String): Set<String> = names[kind].orEmpty()

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
        const val MAX_FLAGS = 16
        const val MAX_SETTING_NUMBER = 10_000_000L

        /** Reads the contract: its `catalogue` (kind → names), `settingValues` and `cliFlags`. */
        fun parse(text: String): AnalyticsCatalogue {
            val root = Json.parseToJsonElement(text) as JsonObject
            val catalogue = root["catalogue"] as? JsonObject ?: error("analytics-v1.json has no catalogue")
            fun words(value: JsonElement?) = (value as? JsonArray)?.mapNotNull { it.string() }?.toSet().orEmpty()
            return AnalyticsCatalogue(
                catalogue.mapValues { (_, names) -> words(names) },
                (root["settingValues"] as? JsonObject)?.mapValues { (_, values) -> words(values) }.orEmpty(),
                words(root["cliFlags"]),
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
