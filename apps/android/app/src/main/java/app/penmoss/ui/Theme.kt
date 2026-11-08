package app.penmoss.ui

import app.penmoss.ui.square.SQUARE_SHAPES
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import android.graphics.Typeface
import androidx.compose.material3.Typography
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import app.penmoss.engine.settings.FontSettings
import app.penmoss.engine.settings.LineSymbols
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The native screens in the theme chosen in Settings → Appearance (T28; T33,
 * A305), from the colours `/sync/tree` sends. Until the phone has synced once,
 * and for any colour missing, Penmoss's own theme (packages/ui/src/theme/
 * builtins.ts, "Penmoss"), light and dark.
 */
private val PENMOSS_LIGHT = mapOf(
    "bg" to "#fbfaf7",
    "sidebar" to "#f1f0ea",
    "raised" to "#ffffff",
    "border" to "#dedbd2",
    "fg" to "#1f2421",
    "muted" to "#57635b",
    "accent" to "#3c7a4b",
    "onAccent" to "#fbfaf6",
    "danger" to "#b3261e",
)

private val PENMOSS_DARK = mapOf(
    "bg" to "#161a17",
    "sidebar" to "#121512",
    "raised" to "#202620",
    "border" to "#2c332e",
    "fg" to "#e6ebe7",
    "muted" to "#9aa69e",
    "accent" to "#7fbf8e",
    "onAccent" to "#111510",
    "danger" to "#f2b8b5",
)

private fun colour(hex: String): Color = Color(0xFF000000 or hex.removePrefix("#").toLong(16))

/**
 * A theme variant's colours as the phone draws them (T40 P9, PL14, A498): each text colour moved
 * only as far as it must be to read at [READABLE] on every surface it is drawn on (review S7),
 * so a custom theme keeps its hue. The text, on the page, the sidebar's menus and sheets, raised
 * dialogs and the accent's soft containers; secondary text and the accent and danger colours
 * on the page, the sidebar and raised surfaces; the text on the accent, on it. Built in, only
 * Nord's and Solarized's light accents move, a little, for the sidebar (`ThemeContrastTest`).
 */
internal class ReadableColours(private val tokens: Map<String, String>, dark: Boolean) {
    private val defaults = if (dark) PENMOSS_DARK else PENMOSS_LIGHT

    private fun token(name: String) = colour(tokens[name] ?: defaults.getValue(name))

    val bg = token("bg")
    val sidebar = token("sidebar")
    val raised = token("raised")
    private val surfaces = listOf(bg, sidebar, raised)
    val accent = readableOn(surfaces, token("accent"))

    /** The accent, softly, as the web's `--pm-accent-soft`. */
    val soft = lerp(bg, accent, 0.18f)
    val fg = readableOn(surfaces + soft, token("fg"))
    val muted = readableOn(surfaces, token("muted"))
    val onAccent = readableOn(listOf(accent), token("onAccent"))
    val danger = readableOn(surfaces, token("danger"))

    /** The tokens the editor page gets for the note (A498): the same colours as the screens. */
    val pageTokens: Map<String, Color> get() = mapOf("fg" to fg, "muted" to muted, "accent" to accent, "danger" to danger)
}

/**
 * The resolved theme for the editor page (A498), with the text colours the native screens use:
 * a token the theme sets and the phone had to move is sent moved, so the note reads as its
 * screen does. Others are sent as they came.
 */
fun readableTheme(theme: JsonObject): JsonObject = JsonObject(
    theme.mapValues { (key, value) ->
        val variant = value as? JsonObject
        if ((key != "light" && key != "dark") || variant == null) return@mapValues value
        val hex = variant.mapNotNull { (name, token) ->
            (token as? JsonPrimitive)?.takeIf { it.isString && HEX.matches(it.content) }?.let { name to it.content }
        }.toMap()
        val moved = ReadableColours(hex, dark = key == "dark").pageTokens
        JsonObject(
            variant.mapValues { (name, token) ->
                val now = moved[name] ?: return@mapValues token
                if (name !in hex || colour(hex.getValue(name)) == now) token else JsonPrimitive(hexOf(now))
            },
        )
    },
)

private val HEX = Regex("^#[0-9a-fA-F]{6}$")

private fun hexOf(colour: Color) = "#%06x".format(colour.toArgb() and 0xFFFFFF)

/** A Material colour scheme from a theme variant's tokens (the web's names: bg, fg, accent…). */
fun penmossColours(tokens: Map<String, String>, dark: Boolean): ColorScheme {
    val colours = ReadableColours(tokens, dark)
    val bg = colours.bg
    val fg = colours.fg
    val accent = colours.accent
    val base = if (dark) darkColorScheme() else lightColorScheme()
    // The accent, softly, as the web's `--pm-accent-soft`: the formatting bar's pressed buttons,
    // and every tonal container Material paints (the Today button, a selected chip, the
    // progress bar's track), which were Material's own lavender before (T39).
    val soft = colours.soft
    return base.copy(
        primary = accent,
        onPrimary = colours.onAccent,
        primaryContainer = soft,
        onPrimaryContainer = fg,
        secondary = accent,
        onSecondary = colours.onAccent,
        secondaryContainer = soft,
        onSecondaryContainer = fg,
        tertiary = accent,
        onTertiary = colours.onAccent,
        tertiaryContainer = soft,
        onTertiaryContainer = fg,
        // Tonal elevation (a sheet, a menu) tints toward the accent, not purple.
        surfaceTint = accent,
        // A snackbar: the theme's text colour as its surface, its background as the text, and the
        // action in the accent, made only as light or dark as it must be to read there (T39 review).
        inverseSurface = fg,
        inverseOnSurface = bg,
        inversePrimary = readableOn(fg, accent),
        surfaceBright = colours.raised,
        surfaceDim = colours.sidebar,
        background = bg,
        onBackground = fg,
        surface = bg,
        onSurface = fg,
        surfaceVariant = colours.sidebar,
        onSurfaceVariant = colours.muted,
        surfaceContainerLowest = bg,
        surfaceContainerLow = bg,
        surfaceContainer = colours.sidebar,
        surfaceContainerHigh = colours.raised,
        surfaceContainerHighest = colours.raised,
        outline = token(tokens, dark, "border"),
        outlineVariant = token(tokens, dark, "border"),
        error = colours.danger,
    )
}

private fun token(tokens: Map<String, String>, dark: Boolean, name: String) =
    colour(tokens[name] ?: (if (dark) PENMOSS_DARK else PENMOSS_LIGHT).getValue(name))

/** WCAG's contrast ratio of two colours (1 to 21). */
internal fun contrast(a: Color, b: Color): Float {
    val (light, dark) = listOf(a.luminance(), b.luminance()).sortedDescending()
    return (light + 0.05f) / (dark + 0.05f)
}

/** Text in a theme's colours reads at this ratio or more (WCAG AA for normal text). */
internal const val READABLE = 4.5f

/**
 * [accent], moved toward white or black (whichever [surface] contrasts with more) only as far as
 * it must be to read at [READABLE] on [surface].
 */
internal fun readableOn(surfaces: List<Color>, colour: Color): Color {
    fun worst(candidate: Color) = surfaces.minOf { contrast(candidate, it) }
    if (worst(colour) >= READABLE) return colour
    val first = surfaces.first()
    val toward = if (contrast(Color.White, first) >= contrast(Color.Black, first)) Color.White else Color.Black
    for (step in 0..STEPS) {
        val candidate = lerp(colour, toward, step / STEPS.toFloat())
        if (worst(candidate) >= READABLE) return candidate
    }
    return toward
}

internal fun readableOn(surface: Color, accent: Color): Color {
    if (contrast(accent, surface) >= READABLE) return accent
    val toward = if (contrast(Color.White, surface) >= contrast(Color.Black, surface)) Color.White else Color.Black
    for (step in 0..STEPS) {
        val candidate = lerp(accent, toward, step / STEPS.toFloat())
        if (contrast(candidate, surface) >= READABLE) return candidate
    }
    return toward
}

private const val STEPS = 40

/**
 * What a search match is painted with (T40 P6, FD1): the theme's `searchMatch` at 38% over its
 * background, as the web's search marks it (`color-mix(… 38%, …)`), with the theme's text on it.
 */
val LocalSearchMatch = staticCompositionLocalOf { lerp(colour(PENMOSS_LIGHT.getValue("bg")), colour(SEARCH_MATCH), 0.38f) }

/** Penmoss's own search colour (packages/ui/src/theme/builtins.ts `searchMatch`). */
private const val SEARCH_MATCH = "#f2c230"

internal fun searchMatchColour(tokens: Map<String, String>, dark: Boolean): Color {
    val defaults = if (dark) PENMOSS_DARK else PENMOSS_LIGHT
    val bg = colour(tokens["bg"] ?: defaults.getValue("bg"))
    return lerp(bg, colour(tokens["searchMatch"] ?: SEARCH_MATCH), 0.38f)
}

/**
 * Line symbols' colours (T44, A747): each colour a symbol may take, the theme's token of that
 * name, moved only as far as it must be to read on the page, the sidebar and raised surfaces,
 * as the text colours are. A token the theme lacks falls back to the accent.
 */
val LocalSymbolColours = staticCompositionLocalOf<Map<String, Color>> { emptyMap() }

internal fun symbolColours(tokens: Map<String, String>, dark: Boolean): Map<String, Color> {
    val colours = ReadableColours(tokens, dark)
    val surfaces = listOf(colours.bg, colours.sidebar, colours.raised)
    return LineSymbols.COLOURS.associate { (key, _) ->
        val hex = tokens[key]?.takeIf { HEX.matches(it) }
        key to (hex?.let { readableOn(surfaces, colour(it)) } ?: colours.accent)
    }
}

/**
 * A custom symbol colour (T51, A939): `#rrggbb` or `#rrggbbaa`, the same in light and dark; null
 * for a theme colour's name.
 */
internal fun hexColour(colour: String): Color? {
    if (!LineSymbols.isHexColour(colour)) return null
    val digits = colour.removePrefix("#")
    val rgb = digits.take(6).toLong(16)
    val alpha = if (digits.length == 8) digits.substring(6).toLong(16) else 0xFF
    return Color((alpha shl 24) or rgb)
}

/** What a line symbol is drawn in: its custom colour, else its theme colour, else the accent. */
@Composable
fun symbolColour(colour: String): Color =
    hexColour(colour) ?: LocalSymbolColours.current[colour] ?: MaterialTheme.colorScheme.primary

/**
 * The family Settings → Appearance's Interface Font names (T51, A944), or null for the theme's
 * own (Material's): a preset is the phone's own sans, serif or mono face (core
 * `FONT_PRESET_ANDROID`); a custom family is the installed one of that name, else the sans.
 */
internal fun interfaceFontFamily(choice: String): FontFamily? {
    if (choice == FontSettings.THEME || FontSettings.choiceProblem(choice) != null) return null
    FontSettings.customFamily(choice)?.let { family ->
        return FontFamily(Typeface.create(family, Typeface.NORMAL))
    }
    return when (FontSettings.ANDROID_FAMILY[choice]) {
        "serif" -> FontFamily.Serif
        "monospace" -> FontFamily.Monospace
        else -> FontFamily.SansSerif
    }
}

/** Material's type scale in [family], or as it is for the theme's own font. */
internal fun penmossTypography(family: FontFamily?): Typography {
    val base = Typography()
    if (family == null) return base
    fun TextStyle.inFamily() = copy(fontFamily = family)
    return Typography(
        displayLarge = base.displayLarge.inFamily(),
        displayMedium = base.displayMedium.inFamily(),
        displaySmall = base.displaySmall.inFamily(),
        headlineLarge = base.headlineLarge.inFamily(),
        headlineMedium = base.headlineMedium.inFamily(),
        headlineSmall = base.headlineSmall.inFamily(),
        titleLarge = base.titleLarge.inFamily(),
        titleMedium = base.titleMedium.inFamily(),
        titleSmall = base.titleSmall.inFamily(),
        bodyLarge = base.bodyLarge.inFamily(),
        bodyMedium = base.bodyMedium.inFamily(),
        bodySmall = base.bodySmall.inFamily(),
        labelLarge = base.labelLarge.inFamily(),
        labelMedium = base.labelMedium.inFamily(),
        labelSmall = base.labelSmall.inFamily(),
    )
}

@Composable
fun PenmossTheme(
    appearance: Appearance = Appearance(),
    dark: Boolean = appearance.isDark(isSystemInDarkTheme()),
    content: @Composable () -> Unit,
) {
    val tokens = appearance.colours(dark)
    val typography = remember(appearance.interfaceFont) { penmossTypography(interfaceFontFamily(appearance.interfaceFont)) }
    MaterialTheme(colorScheme = penmossColours(tokens, dark), shapes = SQUARE_SHAPES, typography = typography) {
        CompositionLocalProvider(
            LocalSearchMatch provides searchMatchColour(tokens, dark),
            LocalSymbolColours provides symbolColours(tokens, dark),
            content = content,
        )
    }
}
