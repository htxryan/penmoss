package app.penmoss.engine.settings

/**
 * Lucide's icons on the phone (A1579): the web's own Lucide (lucide-static's shapes and tags,
 * @lucide/icons' aliases), written into the app's assets by `scripts/lucide-android.mjs` in the
 * compact form [parse] reads. A badge's icon is drawn from its shapes on Lucide's 24-unit grid,
 * stroked 2 wide with round ends; the picker finds one by name and tags as the web's does.
 */
class LucideIcons private constructor(
    /** Every icon, sorted by name, as the web's picker lists them. */
    val all: List<LucideIcon>,
    /** Another name an icon resolves by (Lucide's aliases), to the icon's own name. */
    val aliases: Map<String, String>,
) {
    private val byName: Map<String, LucideIcon> = all.associateBy { it.name }

    /** The icon a name draws: its own, or an alias's; null for a name this build has no icon for. */
    fun icon(name: String): LucideIcon? = byName[name] ?: aliases[name]?.let(byName::get)

    /** What a query finds, best first, by [GlyphSearch]'s rules; every icon for an empty one. */
    fun find(query: String): List<LucideIcon> = GlyphSearch.find(all, query)

    companion object {
        /** The icons from the generator's text: one icon a line, then `=alias<TAB>name` lines. */
        fun parse(text: String): LucideIcons {
            val icons = mutableListOf<LucideIcon>()
            val aliases = linkedMapOf<String, String>()
            for (line in text.lineSequence()) {
                if (line.isEmpty()) continue
                val fields = line.split('\t')
                if (line.startsWith('=')) {
                    aliases[fields[0].substring(1)] = fields[1]
                    continue
                }
                val tags = fields[1].takeIf { it.isNotEmpty() }?.split(',').orEmpty()
                icons += LucideIcon(fields[0], tags, fields.drop(2).map(LucideShape::parse))
            }
            return LucideIcons(icons, aliases)
        }
    }
}

/** One Lucide icon: its name (`notebook-pen`), its tags and its shapes. */
data class LucideIcon(
    override val name: String,
    override val keywords: List<String>,
    val shapes: List<LucideShape>,
) : Findable {
    override val glyph: String? get() = null
}

/**
 * One of an icon's shapes: its SVG element and attributes, as Lucide gives them, and whether it
 * is filled (`fill="currentColor"`) as well as stroked.
 */
data class LucideShape(val element: String, val attributes: Map<String, String>, val filled: Boolean) {
    /** The shape as SVG path data, which Android's path parser draws. */
    fun pathData(): String {
        fun n(name: String) = attributes[name]?.takeIf { it.isNotEmpty() }?.toDouble() ?: 0.0
        fun f(value: Double): String = if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()
        return when (element) {
            "path" -> attributes["d"].orEmpty()
            "circle" -> ellipse(n("cx"), n("cy"), n("r"), n("r"), ::f)
            "ellipse" -> ellipse(n("cx"), n("cy"), n("rx"), n("ry"), ::f)
            "line" -> "M${f(n("x1"))} ${f(n("y1"))}L${f(n("x2"))} ${f(n("y2"))}"
            "polyline", "polygon" -> {
                val points = attributes["points"].orEmpty().trim().split(Regex("[\\s,]+")).filter { it.isNotEmpty() }
                val pairs = points.chunked(2).filter { it.size == 2 }
                pairs.mapIndexed { at, (x, y) -> "${if (at == 0) "M" else "L"}$x $y" }.joinToString("") +
                    if (element == "polygon") "Z" else ""
            }
            "rect" -> rect(n("x"), n("y"), n("width"), n("height"), attributes["rx"], attributes["ry"], ::f)
            else -> ""
        }
    }

    private fun ellipse(cx: Double, cy: Double, rx: Double, ry: Double, f: (Double) -> String): String =
        "M${f(cx - rx)} ${f(cy)}" +
            "A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}" +
            "A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z"

    /** A rectangle, its corners rounded as SVG rounds them: a missing rx or ry takes the other's. */
    private fun rect(x: Double, y: Double, w: Double, h: Double, rxText: String?, ryText: String?, f: (Double) -> String): String {
        val rxGiven = rxText?.takeIf { it.isNotEmpty() }?.toDouble()
        val ryGiven = ryText?.takeIf { it.isNotEmpty() }?.toDouble()
        val rx = minOf(rxGiven ?: ryGiven ?: 0.0, w / 2)
        val ry = minOf(ryGiven ?: rxGiven ?: 0.0, h / 2)
        if (rx <= 0.0 || ry <= 0.0) return "M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z"
        return "M${f(x + rx)} ${f(y)}" +
            "H${f(x + w - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}" +
            "V${f(y + h - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}" +
            "H${f(x + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}" +
            "V${f(y + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z"
    }

    companion object {
        /** Each element's letter in the generator's text, and its attributes in their order. */
        private val ELEMENTS: Map<Char, Pair<String, List<String>>> = mapOf(
            'p' to ("path" to listOf("d")),
            'c' to ("circle" to listOf("cx", "cy", "r")),
            'r' to ("rect" to listOf("x", "y", "width", "height", "rx", "ry")),
            'l' to ("line" to listOf("x1", "y1", "x2", "y2")),
            'e' to ("ellipse" to listOf("cx", "cy", "rx", "ry")),
            'y' to ("polyline" to listOf("points")),
            'g' to ("polygon" to listOf("points")),
        )

        /** `c!:12;13;8`: the letter, `!` when filled, then the attributes. */
        fun parse(text: String): LucideShape {
            val colon = text.indexOf(':')
            val head = text.substring(0, colon)
            val (element, names) = ELEMENTS[head[0]] ?: error("an unknown shape: $text")
            val body = text.substring(colon + 1)
            val values = if (element == "path") listOf(body) else body.split(';')
            val attributes = names.zip(values).filter { (_, value) -> value.isNotEmpty() }.toMap()
            return LucideShape(element, attributes, filled = head.endsWith('!'))
        }
    }
}
