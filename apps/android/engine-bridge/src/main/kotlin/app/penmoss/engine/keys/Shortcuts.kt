package app.penmoss.engine.keys

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Key combinations as the web writes them (T20, A70): `Mod+Shift+E`, modifiers in a fixed order
 * (Mod, Ctrl, Alt, Shift), then one key. On Android, as everywhere off Apple platforms, Mod is the
 * Ctrl key and a Windows or Search key is `Meta`, never part of an app shortcut. A Kotlin port of
 * `@penmoss/editor/keys`, checked against `contract/shortcuts-v1.json` (T40 P9, A492).
 */
object Combos {
    private val ORDER = listOf("Mod", "Ctrl", "Alt", "Shift")
    private val SPLIT = Regex("\\+(?!$)")
    private val FUNCTION_KEY = Regex("^F\\d{1,2}$")
    private val STORED_FUNCTION_KEY = Regex("^F([1-9]|1\\d|2[0-4])$")
    private val LETTER_OR_DIGIT = Regex("^[A-Z0-9]$")

    /** What the web's `CODE_KEYS` names keys that are not letters, digits or F-keys. */
    val NAMED_KEYS: Set<String> = setOf(
        "/", ".", ",", "\\", "[", "]", ";", "'", "-", "=", "`",
        "Space", "Enter", "Escape", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
        "Up", "Down", "Left", "Right",
    )

    /** The most combinations one command may store, and characters one may have (A491). */
    const val MAX_PER_COMMAND = 4
    const val MAX_CHARS = 40

    data class Parts(val modifiers: List<String>, val key: String)

    /** Splits a combination into its known modifiers and key (`+` may itself be the key: `Mod++`). */
    fun parse(combo: String): Parts {
        val parts = combo.split(SPLIT)
        val key = parts.last()
        val modifiers = parts.dropLast(1).mapNotNull { part -> ORDER.firstOrNull { it.equals(part, ignoreCase = true) } }
        return Parts(modifiers, key)
    }

    /** A combination in canonical form: known modifiers in order, a letter upper-case. */
    fun normalise(combo: String): String {
        val (modifiers, key) = parse(combo.trim())
        val ordered = ORDER.filter { it in modifiers }
        return (ordered + if (key.length == 1) key.uppercase() else key).joinToString("+")
    }

    /**
     * The combination for a key with these modifiers, or null for a lone modifier ([key] null).
     * As the web's `comboFromEvent` off Apple platforms: Ctrl is Mod, and Meta is kept so that
     * it never matches a binding.
     */
    fun of(key: String?, ctrl: Boolean, alt: Boolean, shift: Boolean, meta: Boolean): String? {
        if (key == null) return null
        val parts = buildList {
            if (ctrl) add("Mod")
            if (meta) add("Meta")
            if (alt) add("Alt")
            if (shift) add("Shift")
            add(key)
        }
        return parts.joinToString("+")
    }

    /** Why a combination cannot be a binding on this phone (A90), or null when it can. */
    enum class Problem(val wire: String) { TYPES("types"), ALTGR("altgr"), RESERVED("reserved") }

    private fun printable(key: String) = key.length == 1 || key == "Space"

    /**
     * Why [combo] may not be bound off Apple platforms, or null (`bindingProblem`): it needs Mod
     * or Alt, or is a function key, so typing never runs a command; Ctrl+Alt with a printable key
     * is AltGr on many layouts; the clipboard's and editing keys ([reserved]) stay theirs.
     */
    fun problem(combo: String, reserved: Set<String>): Problem? {
        val normalised = normalise(combo)
        val (modifiers, key) = parse(normalised)
        if (key.isEmpty()) return Problem.TYPES
        if (normalised in reserved) return Problem.RESERVED
        if (FUNCTION_KEY.matches(key)) return null
        val command = "Mod" in modifiers || "Ctrl" in modifiers
        val alt = "Alt" in modifiers
        if (!command && !alt) return Problem.TYPES
        if (!printable(key)) return null
        if (alt && "Mod" in modifiers) return Problem.ALTGR
        return null
    }

    private val NAMES = mapOf("Mod" to "Ctrl", "Up" to "↑", "Down" to "↓", "Left" to "←", "Right" to "→", "Escape" to "Esc")

    /** A combination as the phone shows it: `Ctrl+Shift+E`, `Alt+↑` (`formatCombo` off Apple). */
    fun format(combo: String): String {
        val (modifiers, key) = parse(combo)
        return (modifiers + key).joinToString("+") { NAMES[it] ?: it }
    }

    /**
     * Why [value] cannot be stored as a command's bindings, or null (`bindingValueProblem`,
     * A491): a list of at most four combinations, each in canonical form and ending in a key.
     */
    fun storedProblem(value: JsonElement?): String? {
        val list = value as? JsonArray ?: return "must be a list of key combinations"
        if (list.size > MAX_PER_COMMAND) return "must have at most $MAX_PER_COMMAND combinations"
        val seen = HashSet<String>()
        for (item in list) {
            val combo = (item as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (combo == null || combo.isEmpty() || combo.length > MAX_CHARS) return "must be combinations of at most $MAX_CHARS characters"
            val (modifiers, key) = parse(combo)
            if (combo.split(SPLIT).size != modifiers.size + 1 || normalise(combo) != combo) return "$combo is not a combination like Mod+Shift+E"
            val known = LETTER_OR_DIGIT.matches(key) || STORED_FUNCTION_KEY.matches(key) || key in NAMED_KEYS ||
                (key.length == 1 && key.isNotBlank())
            if (!known) return "$combo does not end in a key"
            if (!seen.add(combo)) return "$combo is listed twice"
        }
        return null
    }
}

/** One command of the web's registry (`contract/shortcuts-v1.json`, off Apple platforms). */
data class ShortcutCommand(
    val id: String,
    val title: String,
    val area: String,
    /** `global`, `editor` (the note body has focus) or `tree` (a folder row has focus). */
    val scope: String,
    /** Its default combinations. */
    val keys: List<String>,
    val yields: Boolean = false,
    val hidden: Boolean = false,
    /** The task it arrives with, when it is listed but not run yet. */
    val pending: String? = null,
)

/**
 * The web's command registry and the reserved keys, as the app was built with them: the
 * contract is a resource of this module, like the themes (A412), so the shortcut list and the
 * dispatcher work offline and Kotlin never makes a command up (T40 P9, A492).
 */
class ShortcutCatalogue(val commands: List<ShortcutCommand>, val reserved: Set<String>) {
    private val byId = commands.associateBy { it.id }

    fun command(id: String): ShortcutCommand? = byId[id]

    companion object {
        val bundled: ShortcutCatalogue by lazy {
            val text = ShortcutCatalogue::class.java.getResourceAsStream("/shortcuts-v1.json")?.use { it.readBytes().decodeToString() }
                ?: error("shortcuts-v1.json is missing from the build")
            parse(text)
        }

        fun parse(text: String): ShortcutCatalogue {
            val root = Json.parseToJsonElement(text) as JsonObject
            val commands = (root["commands"] as JsonArray).map { element ->
                val item = element as JsonObject
                fun text(key: String) = (item[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
                fun flag(key: String) = (item[key] as? JsonPrimitive)?.booleanOrNull == true
                ShortcutCommand(
                    id = text("id")!!,
                    title = text("title")!!,
                    area = text("area")!!,
                    scope = text("scope")!!,
                    keys = (item["keys"] as JsonArray).map { (it as JsonPrimitive).content },
                    yields = flag("yields"),
                    hidden = flag("hidden"),
                    pending = text("pending"),
                )
            }
            val reserved = (root["reserved"] as JsonArray).map { (it as JsonPrimitive).content }.toSet()
            return ShortcutCatalogue(commands, reserved)
        }
    }
}

/**
 * The user's bindings over the defaults (A70), with A90's rules applied whenever they are read:
 * from the synced settings' `keys.<id>` entries, which other devices and agents write too. A
 * combination the phone cannot use is dropped unless it is the command's own default; a command
 * left with none keeps its defaults; `[]` (no shortcut, by choice) stays (`usableBindings`).
 */
class Bindings(val catalogue: ShortcutCatalogue, raw: Map<String, JsonElement>) {
    /** The usable bindings by command id: only commands the user rebound. */
    val usable: Map<String, List<String>> = usableOf(raw)

    private fun usableOf(raw: Map<String, JsonElement>): Map<String, List<String>> {
        val out = LinkedHashMap<String, List<String>>()
        for ((id, value) in raw) {
            val list = value as? JsonArray ?: continue
            val combos = list.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return@map null }
            if (combos.any { it == null }) continue
            val defaults = catalogue.command(id)?.keys.orEmpty()
            val kept = combos.filterNotNull().map(Combos::normalise).distinct()
                .filter { it in defaults || Combos.problem(it, catalogue.reserved) == null }
            if (combos.isNotEmpty() && kept.isEmpty()) continue
            out[id] = kept
        }
        return out
    }

    /** The combinations bound to a command now: the user's, else the defaults. */
    fun keysOf(id: String): List<String> = usable[id] ?: catalogue.command(id)?.keys.orEmpty()

    /** Whether the user changed this command's keys (Reset is offered). */
    fun isCustom(id: String): Boolean = id in usable

    /** The commands bound to [combo], the most specific scope first (the web's dispatcher order). */
    fun commandsFor(combo: String): List<ShortcutCommand> =
        catalogue.commands.filter { it.pending == null && combo in keysOf(it.id) }
            .sortedBy { if (it.scope == "global") 1 else 0 }

    /** Other commands [combo] would clash with if bound to [id] (`CommandCenter.conflicts`). */
    fun conflicts(id: String, combo: String): List<ShortcutCommand> {
        val own = catalogue.command(id) ?: return emptyList()
        val wanted = Combos.normalise(combo)
        return catalogue.commands.filter { other ->
            if (other.id == id || !overlap(own.scope, other.scope)) return@filter false
            if (keysOf(other.id).none { Combos.normalise(it) == wanted }) return@filter false
            // A yielding command shares its keys with one of a wider scope by design (A42).
            !((own.yields || other.yields) && own.scope != other.scope)
        }
    }

    /** A combination bound to two commands whose keys can act at once. */
    data class Clash(val combo: String, val first: ShortcutCommand, val second: ShortcutCommand)

    /** Every clash among the bindings now, each pair once (`allConflicts`). */
    fun clashes(): List<Clash> {
        val found = ArrayList<Clash>()
        val seen = HashSet<String>()
        for (command in catalogue.commands) {
            for (combo in keysOf(command.id)) {
                for (other in conflicts(command.id, combo)) {
                    val key = listOf(command.id, other.id).sorted().joinToString(" ") + combo
                    if (seen.add(key)) found += Clash(combo, command, other)
                }
            }
        }
        return found
    }

    private fun overlap(a: String, b: String) = a == b || a == "global" || b == "global"

    companion object {
        /** Synced settings hold each command's bindings under this prefix: `keys.<command id>`. */
        const val PREFIX = "keys."

        /** The bindings in a user's settings values. */
        fun of(catalogue: ShortcutCatalogue, settings: JsonObject): Bindings =
            Bindings(catalogue, settings.filterKeys { it.startsWith(PREFIX) }.mapKeys { it.key.removePrefix(PREFIX) })
    }
}
