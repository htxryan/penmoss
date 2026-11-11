package app.penmoss.engine.settings

import kotlin.math.abs
import kotlin.math.cbrt
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The theme editor's contrast warnings (T40 P1b, A419): a port of `@penmoss/ui`'s colour maths
 * (`colour.ts`) and WCAG checks (`contrast.ts`), so the phone warns about the same pairs, with
 * the same ratios, as the web. `contract/theme-contrast-v1.json` holds the web's answers and
 * `ContrastContractTest` checks this against them. Advisory only: the server's `parseTheme`
 * decides what a theme may hold, and a low contrast never stops a save, as on the web.
 */
object Colour {
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    /** A theme colour: `#rrggbb`. */
    fun isHex(value: String?): Boolean = value != null && HEX.matches(value)

    fun parse(hex: String): IntArray {
        require(isHex(hex)) { "Not a #rrggbb colour: $hex" }
        return intArrayOf(hex.substring(1, 3).toInt(16), hex.substring(3, 5).toInt(16), hex.substring(5, 7).toInt(16))
    }

    /** As JavaScript's `Math.round`: halves go up, towards positive infinity. */
    private fun jsRound(value: Double): Long = kotlin.math.floor(value + 0.5).toLong()

    private fun clampByte(value: Double): Int = min(255L, max(0L, jsRound(value))).toInt()

    fun toHex(r: Double, g: Double, b: Double): String =
        "#" + listOf(r, g, b).joinToString("") { clampByte(it).toString(16).padStart(2, '0') }

    private fun toLinear(channel: Int): Double {
        val c = channel / 255.0
        return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }

    private fun fromLinear(c: Double): Double =
        255 * if (c <= 0.0031308) 12.92 * c else 1.055 * max(0.0, c).pow(1 / 2.4) - 0.055

    /** WCAG 2 relative luminance (0 black … 1 white). */
    fun luminance(hex: String): Double {
        val (r, g, b) = parse(hex).map(::toLinear)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    /** WCAG 2 contrast ratio, 1 … 21. */
    fun contrast(a: String, b: String): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun toOklab(hex: String): DoubleArray {
        val (r, g, b) = parse(hex).map(::toLinear)
        val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return doubleArrayOf(
            0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        )
    }

    private fun fromOklab(lab: DoubleArray): String {
        val (lL, a, b) = Triple(lab[0], lab[1], lab[2])
        val l = (lL + 0.3963377774 * a + 0.2158037573 * b).pow(3)
        val m = (lL - 0.1055613458 * a - 0.0638541728 * b).pow(3)
        val s = (lL - 0.0894841775 * a - 1.291485548 * b).pow(3)
        return toHex(
            fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        )
    }

    /** `color-mix(in oklab, a, b <weightB>)` for opaque colours. */
    fun mix(a: String, b: String, weightB: Double): String {
        val p = toOklab(a)
        val q = toOklab(b)
        return fromOklab(DoubleArray(3) { p[it] * (1 - weightB) + q[it] * weightB })
    }

    /** Hue (0–360), saturation and value (0–1), for the colour sheet's square and slider. */
    fun hsv(hex: String): Triple<Float, Float, Float> {
        val (r, g, b) = parse(hex).map { it / 255f }
        val high = maxOf(r, g, b)
        val low = minOf(r, g, b)
        val delta = high - low
        val hue = when {
            delta == 0f -> 0f
            high == r -> 60f * (((g - b) / delta) % 6f)
            high == g -> 60f * ((b - r) / delta + 2f)
            else -> 60f * ((r - g) / delta + 4f)
        }.let { if (it < 0f) it + 360f else it }
        return Triple(hue, if (high == 0f) 0f else delta / high, high)
    }

    /** The `#rrggbb` for a hue (0–360), saturation and value (0–1). */
    fun fromHsv(hue: Float, saturation: Float, value: Float): String {
        val h = ((hue % 360f) + 360f) % 360f
        val c = value * saturation
        val x = c * (1 - abs((h / 60f) % 2f - 1))
        val m = value - c
        val (r, g, b) = when ((h / 60f).toInt()) {
            0 -> Triple(c, x, 0f)
            1 -> Triple(x, c, 0f)
            2 -> Triple(0f, c, x)
            3 -> Triple(0f, x, c)
            4 -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }
        return toHex(((r + m) * 255).toDouble(), ((g + m) * 255).toDouble(), ((b + m) * 255).toDouble())
    }

    /** `color-mix(in oklab, colour <alpha>, transparent)` painted over `surface`, composited in sRGB. */
    fun over(colour: String, alpha: Double, surface: String): String {
        val c = parse(colour)
        val s = parse(surface)
        return toHex(c[0] * alpha + s[0] * (1 - alpha), c[1] * alpha + s[1] * (1 - alpha), c[2] * alpha + s[2] * (1 - alpha))
    }

}

/** One pair the app paints: what is read on what, its colours, and the WCAG minimum it needs. */
data class ContrastCheck(
    val label: String,
    val fg: String,
    val bg: String,
    val kind: String,
    val min: Double,
    val ratio: Double,
    /** The theme tokens the pair is made from, so the editor can mark their rows. */
    val tokens: Set<String>,
) {
    val fails: Boolean get() = ratio < min
}

object Contrast {
    const val TEXT_MIN = 4.5
    const val UI_MIN = 3.0
    const val EDGE_MIN = 1.1

    private val CODE = listOf(
        "codeKeyword" to "Keywords", "codeString" to "Strings", "codeComment" to "Comments",
        "codeNumber" to "Numbers", "codeFunction" to "Functions", "codeType" to "Types",
        "codeVariable" to "Variables", "codeMeta" to "Meta", "codeTag" to "Tags",
    )
    private val CALLOUTS = listOf(
        "calloutNote" to "Note", "calloutAbstract" to "Abstract", "calloutTip" to "Tip",
        "calloutSuccess" to "Success", "calloutQuestion" to "Question", "calloutWarning" to "Warning",
        "calloutFailure" to "Failure", "calloutExample" to "Example", "calloutQuote" to "Quote",
    )
    private val GRAPH = listOf(
        "graphFocus" to "focused note", "graphUngrouped" to "ungrouped notes",
    ) + (1..8).map { "graph$it" to "group $it" }

    /** A colour the app paints and the theme tokens it is made from. */
    private class Tone(val hex: String, val tokens: Set<String>)

    /**
     * Every pair to check for one variant ([c]: token → `#rrggbb`), in the web's order. Each pair
     * names every token its two colours are made from, the derived ones too (a hovered row is the
     * text colour over the page), so a warning shows beside each colour that changes it.
     */
    fun checks(c: Map<String, String>): List<ContrastCheck> {
        fun t(key: String) = Tone(c.getValue(key), setOf(key))
        fun over(top: String, alpha: Double, under: String) = Tone(Colour.over(c.getValue(top), alpha, c.getValue(under)), setOf(top, under))
        fun mix(a: String, b: String, weight: Double) = Tone(Colour.mix(c.getValue(a), c.getValue(b), weight), setOf(a, b))
        val hoverBg = over("fg", 0.06, "bg")
        val hoverSidebar = over("fg", 0.06, "sidebar")
        val hoverRaised = over("fg", 0.06, "raised")
        val activeSidebar = over("fg", 0.09, "sidebar")
        val activeBg = over("fg", 0.09, "bg")
        val accentSoft = over("accent", 0.14, "bg")
        val accentSoftRaised = over("accent", 0.14, "raised")
        val codeBg = mix("bg", "fg", 0.06)
        val searchMark = over("searchMatch", 0.38, "raised")
        val backlinkMark = over("highlight", 0.7, "bg")
        val focus = mix("accent", "fg", 0.3)

        val out = mutableListOf<ContrastCheck>()
        fun add(kind: String, minimum: Double, label: String, fg: Tone, bg: Tone) {
            out += ContrastCheck(label, fg.hex, bg.hex, kind, minimum, Colour.contrast(fg.hex, bg.hex), fg.tokens + bg.tokens)
        }
        fun text(label: String, fg: Tone, bg: Tone) = add("text", TEXT_MIN, label, fg, bg)
        fun ui(label: String, fg: Tone, bg: Tone) = add("ui", UI_MIN, label, fg, bg)
        fun edge(label: String, fg: Tone, bg: Tone) = add("edge", EDGE_MIN, label, fg, bg)

        val surfaces = listOf(
            "the page" to t("bg"),
            "the sidebar" to t("sidebar"),
            "a menu or dialog" to t("raised"),
            "a hovered row" to hoverBg,
            "a hovered sidebar row" to hoverSidebar,
            "a hovered menu item" to hoverRaised,
            "a selected sidebar row" to activeSidebar,
            "a pressed button" to activeBg,
        )
        for ((where, bg) in surfaces) {
            text("Text on $where", t("fg"), bg)
            text("Secondary text on $where", t("muted"), bg)
        }
        text("Text in a code block", t("fg"), codeBg)
        text("Text on a warning", t("fg"), t("warnBg"))
        text("Highlighted text", t("fg"), t("highlight"))
        text("A search match", t("fg"), searchMark)
        text("A backlink match", t("fg"), backlinkMark)
        for ((where, bg) in listOf("the page" to t("bg"), "a menu or dialog" to t("raised"), "a hovered menu item" to hoverRaised)) {
            text("Accent text on $where", t("accent"), bg)
            text("A link on $where", t("link"), bg)
        }
        // A notebook's name in the sidebar (T52 item 11): the accent a quarter of the way to the text.
        val notebookName = mix("accent", "fg", 0.25)
        text("A notebook’s name on the sidebar", notebookName, t("sidebar"))
        text("A notebook’s name on a hovered sidebar row", notebookName, hoverSidebar)
        text("Text on the selected palette option", t("fg"), accentSoftRaised)
        text("Danger text on the page", t("danger"), t("bg"))
        text("Danger text on a menu or dialog", t("danger"), t("raised"))
        text("Danger text on a hovered menu item", t("danger"), hoverRaised)
        text("Text on the accent (primary button)", t("onAccent"), t("accent"))
        text("A tooltip", t("bg"), t("fg"))
        // A toast is a raised card in the theme's colours (PEN-63): its text, its action and its glyphs.
        text("Toast text", t("fg"), t("raised"))
        text("A toast’s action", t("accent"), t("raised"))
        text("A toast’s action, hovered", t("accent"), hoverRaised)
        text("An agent label", t("bg"), t("agent"))
        for ((key, name) in CODE) text("Code: $name", t(key), codeBg)
        for ((key, name) in CALLOUTS) text("Callout label: $name", t(key), mix("bg", key, 0.07))

        ui("Focus ring on the page", focus, t("bg"))
        ui("Focus ring on a menu or dialog", focus, t("raised"))
        ui("Success icon on the page", t("success"), t("bg"))
        ui("Success icon on the sidebar", t("success"), t("sidebar"))
        ui("Accent icon on a selected sidebar row", t("accent"), activeSidebar)
        ui("Accent icon on a pressed toggle", t("accent"), accentSoft)
        ui("Accent icon on the sidebar", t("accent"), t("sidebar"))
        ui("A toast’s check", t("accent"), t("raised"))
        ui("A toast’s warning", t("danger"), t("raised"))
        for ((key, name) in GRAPH) ui("Graph: $name", t(key), t("bg"))
        for ((key, name) in CALLOUTS) ui("Callout marker: $name", t(key), t("bg"))
        edge("Borders on the page", t("border"), t("bg"))
        edge("Borders on the sidebar", t("border"), t("sidebar"))
        edge("Borders on a menu or dialog", t("border"), t("raised"))
        return out
    }

    /** The checks a variant fails (none for every built-in). */
    fun problems(c: Map<String, String>): List<ContrastCheck> = checks(c).filter { it.fails }
}
