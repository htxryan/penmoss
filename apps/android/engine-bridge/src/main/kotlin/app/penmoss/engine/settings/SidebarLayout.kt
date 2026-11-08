package app.penmoss.engine.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The sidebar's sections (T53 item 8, A983), by core `sidebar-layout.ts`'s rules: Quick Access,
 * Recent Notes, Notebooks, Calendar and Tags, in an order a person drags them into, each one
 * hidden or shown; how many notes Recent Notes shows; and whether Quick Access names each note's
 * notebook (T53 item 10). Home shows the sections it has (Quick Access, Notebooks and Recent
 * Notes) in that order. Checked against `contract/settings-v1.json`.
 */
object SidebarLayout {
    const val QUICK_ACCESS = "quickAccess"
    const val RECENT = "recent"
    const val NOTEBOOKS = "notebooks"
    const val CALENDAR = "calendar"
    const val TAGS = "tags"

    /** The sections, in the default order. */
    val SECTIONS = listOf(QUICK_ACCESS, RECENT, NOTEBOOKS, CALENDAR, TAGS)

    /** Each section's name, as its title and the ⋮ menu's Show and Hide say it. */
    val NAMES = mapOf(
        QUICK_ACCESS to "Quick Access",
        RECENT to "Recent Notes",
        NOTEBOOKS to "Notebooks",
        CALENDAR to "Calendar",
        TAGS to "Tags",
    )

    const val RECENT_DEFAULT = 10
    const val RECENT_MIN = 1
    const val RECENT_MAX = 50

    private val SECTION_ID = Regex("^[A-Za-z]{1,40}$")

    private fun listProblem(value: JsonElement): String? {
        val list = value as? JsonArray ?: return "Must be a list of sections"
        if (list.size > 20) return "Must be a list of sections"
        val seen = mutableSetOf<String>()
        for (item in list) {
            val id = (item as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (id == null || !SECTION_ID.matches(id)) return "Must hold section ids"
            if (!seen.add(id)) return "Repeats $id"
        }
        return null
    }

    /** Why [value] cannot be stored as the layout setting [key], or null when it can. */
    fun problem(key: String, value: JsonElement?): String? {
        if (value == null || value is JsonNull) return null
        return when (key) {
            SettingKeys.SECTION_ORDER, SettingKeys.HIDDEN_SECTIONS -> listProblem(value)
            SettingKeys.RECENT_COUNT -> {
                val primitive = value as? JsonPrimitive
                val number = primitive?.takeIf { !it.isString }?.content?.toIntOrNull()
                if (number != null && number in RECENT_MIN..RECENT_MAX) null else "Must be a whole number from $RECENT_MIN to $RECENT_MAX"
            }
            SettingKeys.QUICK_ACCESS_NOTEBOOK ->
                if ((value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != null) null else "Must be true or false"
            else -> "Not a sidebar setting"
        }
    }

    private fun list(key: String, value: JsonElement?): List<String> {
        if (value == null || value is JsonNull || problem(key, value) != null) return emptyList()
        return (value as JsonArray).map { (it as JsonPrimitive).content }.filter { it in SECTIONS }
    }

    /** Every section in the order shown, hidden ones included (core `sectionOrderOf`). */
    fun order(value: JsonElement?): List<String> {
        val stored = list(SettingKeys.SECTION_ORDER, value)
        return stored + SECTIONS.filter { it !in stored }
    }

    /** The sections hidden. */
    fun hidden(value: JsonElement?): Set<String> = list(SettingKeys.HIDDEN_SECTIONS, value).toSet()

    /** How many notes Recent Notes shows. */
    fun recentCount(value: JsonElement?): Int =
        if (value != null && value !is JsonNull && problem(SettingKeys.RECENT_COUNT, value) == null) (value as JsonPrimitive).intOrNull ?: RECENT_DEFAULT else RECENT_DEFAULT

    /** The order with [id] moved to [index] among every section (core `movedSection`). */
    fun moved(order: List<String>, id: String, index: Int): List<String> {
        val rest = order - id
        val at = index.coerceIn(0, rest.size)
        return rest.subList(0, at) + id + rest.subList(at, rest.size)
    }

    /** The hidden sections with [id] hidden or shown, in the default order (core `withSectionHidden`). */
    fun withHidden(hidden: Set<String>, id: String, hide: Boolean): List<String> =
        SECTIONS.filter { if (it == id) hide else it in hidden }

    /** The ⋮ menu's items: Show or Hide for each of [sections], by name A to Z (core `sectionToggles`). */
    fun toggles(hidden: Set<String>, sections: List<String> = SECTIONS): List<Pair<String, String>> =
        sections.sortedBy { NAMES.getValue(it) }.map { id -> id to "${if (id in hidden) "Show" else "Hide"} ${NAMES.getValue(id)}" }

    fun toJson(list: List<String>): JsonArray = JsonArray(list.map(::JsonPrimitive))
}
